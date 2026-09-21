"""Matching/optimization metrikleri (research-metrics §2.2 ve §2.3).

Metrik tanımları deneyden **önce** yazılmıştır (ADR-0012 §5); burada uygulanırlar.
Tek bir "başarı oranı" raporlanmaz: aynı sistem atama oranını yükseltip kısıt
ihlali üreterek "iyileşmiş" görünebilir. Bu yüzden atama oranı, kabul oranı, kısıt
ihlali oranı ve seyahat maliyeti **birlikte** raporlanır.

Doğrulayıcı (`verify_solution`) kollardan bağımsızdır: baseline ile proposed aynı
ölçüte karşı denetlenir. Kolun kendi iç kontrolüne güvenmek, kuralları hiç kontrol
etmeyen baseline'ı sıfır ihlalli göstermek olurdu.
"""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, timedelta, timezone
from uuid import UUID

from app.evaluation.calibration import CalibrationReport
from app.matching.constraints import evaluate, feasible_intervals
from app.matching.schema import (
    Assignment,
    BookingDemand,
    ConstraintCode,
    Interval,
    RequestRanking,
)
from app.routing.port import RoutingProvider


def percentile(values: list[float], fraction: float) -> float:
    """En yakın sıra (nearest-rank) yüzdelik: `ceil(p·n)`.

    Interpolasyonlu yüzdelik küçük örneklemde var olmayan bir değer üretir; gecikme
    raporunda "gerçekten ölçülmüş bir değer" tercih edilir.

    `round()` kullanılmaz: Python'da bankacı yuvarlaması yapar ve `p·n` tam sayı
    olduğunda sonucu bir sıra yukarı kaydırırdı (n=6, p50 → 4. sıra, oysa doğrusu
    3.). Ölçüm kodundaki sessiz bir kayma, raporlanan gecikmeyi olduğundan kötü
    gösterirdi.
    """
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(fraction * len(ordered)) - 1))
    return round(ordered[index], 3)


@dataclass(frozen=True)
class SolutionAudit:
    """Bir çözümün kısıt denetimi.

    `violating_requests` yalnızca sayı değil **kimlik** taşır: geçerli/geçersiz
    ayrımı olmadan kabul oranı ve seyahat maliyeti gibi metrikler geçersiz atamaları
    da sayar ve hiçbir kuralı kontrol etmeyen bir kolu iyi gösterir.
    """

    assignment_count: int
    violating_requests: frozenset[UUID]
    violations_by_code: dict[str, int] = field(default_factory=dict)
    #: Aynı sağlayıcının ardışık hizmetleri arasındaki yol süresi toplamı — yani
    #: optimizasyonun asıl azaltmaya çalıştığı maliyet. Denetim zaten her ardışık
    #: çifti geziyor; ölçümü orada toplamak ikinci bir geçişten ucuz.
    realized_route_seconds: int = 0

    @property
    def violating_assignments(self) -> int:
        return len(self.violating_requests)

    @property
    def violation_rate(self) -> float:
        if self.assignment_count == 0:
            return 0.0
        return round(self.violating_assignments / self.assignment_count, 4)


def verify_solution(
    demands: tuple[BookingDemand, ...],
    assignments: tuple[Assignment, ...],
    *,
    max_distance_meters: int,
    service_timezone: timezone,
    router: RoutingProvider,
) -> SolutionAudit:
    """Üretilen atamaları hard constraint'lere karşı denetler.

    Üç aile kontrol edilir:

    1. **Aday bazlı kısıtlar** (`constraints.evaluate`): doğrulama, hizmet, yetkinlik,
       müsaitlik, bölge, mesafe, kapasite.
    2. **Takvim uygunluğu**: atanan zaman aralığı, adayın gerçekten müsait olduğu bir
       aralığın tamamen içinde mi?
    3. **Çözüm içi tutarlılık**: aynı sağlayıcıya atanan iki hizmet çakışıyor mu,
       aralarında yolu kat edecek süre var mı, günlük kapasite aşıldı mı?

    Üçüncü aile tek başına adaya bakarak görülemez: "her atama ayrı ayrı geçerli ama
    birlikte imkânsız" durumu tam olarak naif atamanın ürettiği hatadır.
    """
    demand_by_request = {demand.request_id: demand for demand in demands}
    violations: Counter[str] = Counter()
    violating: set[UUID] = set()
    realized_route_seconds = 0

    by_provider: dict[UUID, list[tuple[Assignment, BookingDemand]]] = {}
    used_capacity: Counter[tuple[UUID, date]] = Counter()
    capacity_limit: dict[tuple[UUID, date], int] = {}

    for assignment in assignments:
        demand = demand_by_request.get(assignment.request_id)
        if demand is None:
            violations["UNKNOWN_REQUEST"] += 1
            violating.add(assignment.request_id)
            continue

        candidate = next(
            (item for item in demand.candidates if item.provider_id == assignment.provider_id),
            None,
        )
        if candidate is None:
            violations["UNKNOWN_CANDIDATE"] += 1
            violating.add(assignment.request_id)
            continue

        for code in evaluate(demand, candidate, max_distance_meters=max_distance_meters):
            # Kapasite kısıtı çözüm seviyesinde ayrıca ölçülür; aday seviyesindeki
            # kontrol "zaten dolu mu" sorusudur ve ikisi farklı hatalardır.
            violations[code.value] += 1
            violating.add(assignment.request_id)

        scheduled = Interval(start=assignment.scheduled_start, end=assignment.scheduled_end)
        if scheduled.minutes != demand.duration_minutes:
            violations["DURATION_MISMATCH"] += 1
            violating.add(assignment.request_id)
        elif not any(
            interval.contains(scheduled) for interval in feasible_intervals(demand, candidate)
        ):
            violations[ConstraintCode.NOT_AVAILABLE.value] += 1
            violating.add(assignment.request_id)

        by_provider.setdefault(assignment.provider_id, []).append((assignment, demand))
        day = assignment.scheduled_start.astimezone(service_timezone).date()
        key = (assignment.provider_id, day)
        used_capacity[key] += 1
        limit = candidate.max_daily_bookings - candidate.daily_booking_count
        # En muhafazakâr değer alınır: aynı sağlayıcı birden fazla talepte aday
        # olabilir ve üzerine yazmak, en gevşek sınırın kazanmasına yol açardı.
        capacity_limit[key] = min(capacity_limit.get(key, limit), limit)

    for key, used in used_capacity.items():
        if used > max(0, capacity_limit.get(key, 0)):
            violations["CAPACITY_EXCEEDED_IN_SOLUTION"] += 1
            for assignment, _ in by_provider.get(key[0], []):
                if assignment.scheduled_start.astimezone(service_timezone).date() == key[1]:
                    violating.add(assignment.request_id)

    for provider_id, entries in by_provider.items():
        ordered = sorted(entries, key=lambda item: item[0].scheduled_start)
        for index in range(len(ordered) - 1):
            current, current_demand = ordered[index]
            following, following_demand = ordered[index + 1]

            if following.scheduled_start < current.scheduled_end:
                violations["OVERLAPPING_ASSIGNMENTS"] += 1
                violating.add(current.request_id)
                violating.add(following.request_id)
                continue

            # Çakışmıyor olmak yetmez: sağlayıcının aradaki yolu kat etmesi gerekir.
            # Bu kontrol olmadan, baseline'ın "şehrin bir ucundan diğerine, arka arkaya"
            # ataması geçerli sayılırdı — oysa `baseline.py` bu eksiği **ölçülen**
            # kusurları arasında sayıyor.
            travel = router.estimate(
                current_demand.location, following_demand.location
            ).duration_seconds
            realized_route_seconds += travel
            if following.scheduled_start < current.scheduled_end + timedelta(seconds=travel):
                violations["INSUFFICIENT_TRAVEL_TIME"] += 1
                violating.add(current.request_id)
                violating.add(following.request_id)
        del provider_id

    return SolutionAudit(
        assignment_count=len(assignments),
        violating_requests=frozenset(violating),
        violations_by_code=dict(sorted(violations.items())),
        realized_route_seconds=realized_route_seconds,
    )


def recall_at_k(
    rankings: tuple[RequestRanking, ...],
    ground_truth: dict[UUID, UUID],
    k: int,
) -> tuple[float, int]:
    """Recall@K ve ölçüme giren talep sayısı.

    Yalnızca **gerçek cevabı olan** talepler sayılır: uygun hiçbir sağlayıcı yoksa
    "ilk K içinde bulundu mu" sorusunun anlamı yoktur ve o talepleri 0 saymak metriği
    senaryo zorluğuna göre kaydırırdı.
    """
    considered = 0
    hits = 0

    for ranking in rankings:
        expected = ground_truth.get(ranking.request_id)
        if expected is None:
            continue
        considered += 1
        top = [candidate.provider_id for candidate in ranking.candidates[:k]]
        if expected in top:
            hits += 1

    if considered == 0:
        return 0.0, 0
    return round(hits / considered, 4), considered


@dataclass(frozen=True)
class MatchingReport:
    """Bir kolun (baseline veya proposed) tüm metrikleri."""

    arm: str
    algorithm_version: str
    weights_version: str
    objective_version: str
    scenario_count: int
    demand_count: int

    #: K → Recall@K. `recall_support`, ölçüme giren talep sayısıdır.
    recall_at: dict[str, float]
    recall_support: int

    mean_candidate_count: float
    mean_eligible_count: float

    #: Atanan talep oranı — **geçerliliğe bakmaz**. Tek başına yanıltıcıdır:
    #: hiçbir kuralı kontrol etmeyen bir kol her talebe birini atayıp 1.0 alır.
    assignment_rate: float
    #: Kısıt denetiminden geçen atamaların talep sayısına oranı. Karşılaştırmanın
    #: asıl atama metriği budur.
    valid_assignment_rate: float
    #: Simüle edilmiş kabul modeli — mutlak iddia taşımaz, kollar arası karşılaştırılır.
    #: **Yalnızca geçerli atamalar** üzerinden hesaplanır.
    acceptance_rate: float
    accepted_assignment_rate: float

    constraint_violation_rate: float
    violations_by_code: dict[str, int]

    #: **İlk ayak** seyahati: sağlayıcının referans noktasından hizmet adresine.
    #:
    #: Adlandırma önemlidir. Bu metrik, optimizasyonun kısıtladığı ve cezalandırdığı
    #: **hizmetler arası** yolu içermez (bkz. `realized_route_seconds`). Yalnızca
    #: "hangi sağlayıcı seçildi" sorusunun mesafe sonucudur; rota verimliliğinin
    #: ölçüsü değildir. Önceki adlandırma (`total_travel_seconds`) bu ayrımı
    #: gizliyordu ve rota optimizasyonunu, onu hiç görmeyen bir metrikle yargılıyordu.
    #:
    #: Yalnızca **geçerli** atamalar toplanır: geçersiz atamaları saymak, "en yakını
    #: seç, kuralı boşver" kolunu düşük maliyetli gösterirdi.
    total_first_leg_seconds: int
    total_first_leg_meters: int
    mean_first_leg_seconds: float
    mean_first_leg_meters: float
    #: Gerçekleşen rota: her sağlayıcının o gün sırayla gittiği hizmetler arasındaki
    #: yol süresi toplamı. Optimizasyonun asıl hedeflediği maliyet budur.
    realized_route_seconds: int

    ranking_latency_p50_ms: float
    ranking_latency_p95_ms: float
    end_to_end_latency_p50_ms: float
    end_to_end_latency_p95_ms: float
    optimization_runtime_p50_ms: float
    optimization_runtime_p95_ms: float

    fallback_rate: float
    #: Atanan adayın sıralamadaki ortalama yeri — "hep 1 mi?" sorusunun yanıtı.
    mean_assigned_rank: float
    #: Talep → (saniye, metre), yalnızca **geçerli** atamalar için. Eşleştirilmiş
    #: (paired) seyahat karşılaştırması bunsuz yapılamaz: kolların geçerli atama
    #: kümeleri farklı olduğu için ortalamalar doğrudan kıyaslanamaz.
    travel_by_request: dict[str, tuple[int, int]] = field(default_factory=dict)
    #: Talep → kabul edildi mi (yalnızca geçerli atamalar). Kabul oranı da
    #: seyahatle aynı seçilim yanlılığını taşır: baseline'ın geçerli atama kümesi
    #: tanımı gereği en yakın tekliflerden oluşur ve kabul modeli yol yüküne
    #: bağlıdır. Eşleştirilmemiş bir kabul kıyası, algoritmayı değil o yanlılığı ölçer.
    acceptance_by_request: dict[str, bool] = field(default_factory=dict)
    calibration: CalibrationReport | None = None


def compare(baseline: MatchingReport, proposed: MatchingReport) -> dict[str, float]:
    """İki kolun farkı. İşaretler doğrudan okunur; azalması iyi olanlar not edilir."""

    def delta(first: float, second: float) -> float:
        return round(second - first, 4)

    # Toplam seyahat, kollar farklı sayıda geçerli atama ürettiği için doğrudan
    # karşılaştırılamaz: daha az atama yapan kol otomatik olarak "daha az yol"
    # gösterir. Karşılaştırma **atama başına ortalama** üzerinden yapılır — ve
    # yalnızca ilk ayak için; gerçekleşen rota ayrı raporlanır.
    travel_reduction = (
        round(
            (baseline.mean_first_leg_seconds - proposed.mean_first_leg_seconds)
            / baseline.mean_first_leg_seconds,
            4,
        )
        if baseline.mean_first_leg_seconds > 0
        else 0.0
    )
    distance_reduction = (
        round(
            (baseline.mean_first_leg_meters - proposed.mean_first_leg_meters)
            / baseline.mean_first_leg_meters,
            4,
        )
        if baseline.mean_first_leg_meters > 0
        else 0.0
    )

    return {
        "recall_at_1": delta(baseline.recall_at["1"], proposed.recall_at["1"]),
        "recall_at_5": delta(baseline.recall_at["5"], proposed.recall_at["5"]),
        "recall_at_10": delta(baseline.recall_at["10"], proposed.recall_at["10"]),
        "assignment_rate": delta(baseline.assignment_rate, proposed.assignment_rate),
        "valid_assignment_rate": delta(
            baseline.valid_assignment_rate, proposed.valid_assignment_rate
        ),
        # Ham kabul oranı seçilim yanlılığı taşır; eşleştirilmiş değeri
        # `paired_acceptance` altında raporlanır ve karşılaştırma oradan okunur.
        "acceptance_rate_unpaired": delta(baseline.acceptance_rate, proposed.acceptance_rate),
        "accepted_assignment_rate": delta(
            baseline.accepted_assignment_rate, proposed.accepted_assignment_rate
        ),
        # Azalması iyidir: pozitif delta kötüdür.
        "constraint_violation_rate": delta(
            baseline.constraint_violation_rate, proposed.constraint_violation_rate
        ),
        # Oran olarak **azalma**: pozitif değer iyileşmedir.
        "first_leg_travel_reduction": travel_reduction,
        "first_leg_distance_reduction": distance_reduction,
        "end_to_end_latency_p95_ms": delta(
            baseline.end_to_end_latency_p95_ms, proposed.end_to_end_latency_p95_ms
        ),
    }


@dataclass(frozen=True)
class PairedTravel:
    """Her iki kolun da **geçerli** biçimde atadığı talepler üzerinde seyahat kıyası.

    Neden gerekli: kolların geçerli atama kümeleri farklıdır. Baseline yalnızca "en
    yakın sağlayıcı tesadüfen tüm kuralları sağlıyordu" taleplerinde geçerli atama
    üretir; bu küme tanımı gereği kısa mesafelidir. Ortalama seyahati doğrudan
    karşılaştırmak, bu seçilim yanlılığını algoritma farkı sanmak olurdu.

    Eşleştirilmiş küme küçükse sonuç zayıf kanıttır; `request_count` bu yüzden
    raporun parçasıdır.
    """

    request_count: int
    baseline_total_seconds: int
    proposed_total_seconds: int
    baseline_total_meters: int
    proposed_total_meters: int

    @property
    def travel_time_reduction(self) -> float:
        if self.baseline_total_seconds == 0:
            return 0.0
        return round(
            (self.baseline_total_seconds - self.proposed_total_seconds)
            / self.baseline_total_seconds,
            4,
        )

    @property
    def distance_reduction(self) -> float:
        if self.baseline_total_meters == 0:
            return 0.0
        return round(
            (self.baseline_total_meters - self.proposed_total_meters) / self.baseline_total_meters,
            4,
        )


def paired_travel(baseline: MatchingReport, proposed: MatchingReport) -> PairedTravel:
    """İki kolun ortak geçerli atama kümesindeki seyahat toplamları."""
    shared = sorted(set(baseline.travel_by_request) & set(proposed.travel_by_request))

    return PairedTravel(
        request_count=len(shared),
        baseline_total_seconds=sum(baseline.travel_by_request[key][0] for key in shared),
        proposed_total_seconds=sum(proposed.travel_by_request[key][0] for key in shared),
        baseline_total_meters=sum(baseline.travel_by_request[key][1] for key in shared),
        proposed_total_meters=sum(proposed.travel_by_request[key][1] for key in shared),
    )


@dataclass(frozen=True)
class PairedAcceptance:
    """Her iki kolun da geçerli atadığı talepler üzerinde kabul kıyası.

    `PairedTravel` ile aynı gerekçe: kolların geçerli atama kümeleri farklıdır ve
    baseline'ınki tanımı gereği kısa mesafeli tekliflerden oluşur. Kabul modeli yol
    yüküne bağlı olduğu için (bkz. `fixtures.acceptance`), eşleştirmeden yapılan
    kıyas algoritma farkını değil küme farkını ölçer.
    """

    request_count: int
    baseline_accepted: int
    proposed_accepted: int

    @property
    def baseline_rate(self) -> float:
        if self.request_count == 0:
            return 0.0
        return round(self.baseline_accepted / self.request_count, 4)

    @property
    def proposed_rate(self) -> float:
        if self.request_count == 0:
            return 0.0
        return round(self.proposed_accepted / self.request_count, 4)

    @property
    def delta(self) -> float:
        return round(self.proposed_rate - self.baseline_rate, 4)


def paired_acceptance(baseline: MatchingReport, proposed: MatchingReport) -> PairedAcceptance:
    """İki kolun ortak geçerli atama kümesindeki kabul sayıları."""
    shared = sorted(set(baseline.acceptance_by_request) & set(proposed.acceptance_by_request))

    return PairedAcceptance(
        request_count=len(shared),
        baseline_accepted=sum(1 for key in shared if baseline.acceptance_by_request[key]),
        proposed_accepted=sum(1 for key in shared if proposed.acceptance_by_request[key]),
    )
