"""Karar zinciri: sıralama → optimizasyon → doğrulama.

Zincirin sırası ADR-0007'deki sıradır ve katmanlar birbirinin yerine geçmez:

    aday havuzu (core) → hard constraints → scoring → ranking → optimization → doğrulama

Son adım bir **son savunmadır**: optimizasyonun ürettiği her atama, kısıt
değerlendirmesinden geçmiş bir adaya ve gerçekten müsait bir zaman aralığına
karşılık geliyor mu diye yeniden kontrol edilir. Kontrolden geçmeyen atama sonuçtan
**çıkarılır** ve sayaca yazılır — "hard constraint ihlali hiçbir skorla telafi
edilmez" kuralı, modelin doğru kurulduğuna güvenerek değil, ölçerek korunur.
"""

from __future__ import annotations

import time
from datetime import date, timezone
from uuid import UUID

from app.matching.constraints import feasible_intervals, remaining_capacity
from app.matching.ranking import rank_demand
from app.matching.schema import (
    Assignment,
    BookingDemand,
    DegradedReason,
    Interval,
    RequestRanking,
    SolveRequest,
    SolveResult,
    SolveStrategy,
    Unassigned,
    UnassignedReason,
)
from app.matching.weights import get_weights
from app.optimization import greedy
from app.optimization.model import SolverStatus
from app.optimization.model import solve as optimize
from app.routing.haversine import HaversineRouter
from app.routing.port import RoutingProvider
from app.routing.registry import FallbackRouter, get_router


def _verify(
    demands: tuple[BookingDemand, ...],
    rankings: tuple[RequestRanking, ...],
    assignments: tuple[Assignment, ...],
    *,
    service_timezone: timezone,
) -> tuple[tuple[Assignment, ...], int]:
    """İhlalli atamaları ayıklar; (geçerli atamalar, ihlal sayısı) döner.

    İki aile kontrol edilir ve ikisi de gereklidir:

    1. **Aday bazlı**: atanan sağlayıcı sıralamada mıydı, kısıtları sağlıyor mu,
       önerilen takvim gerçekten müsait bir aralığın içinde mi, süre doğru mu?
    2. **Çözüm içi**: aynı sağlayıcıya atanan iki hizmet çakışıyor mu, günlük
       kapasite aşıldı mı?

    İkinci aile tek başına adaya bakarak görülemez: "her atama ayrı ayrı geçerli ama
    birlikte imkânsız" tam olarak bir çözücü hatasının üreteceği durumdur. Bu kontrol
    yalnızca benchmark'ta yapılsaydı, üretimde böyle bir hata `constraint_violations = 0`
    ile raporlanır ve hiç fark edilmezdi.
    """
    demand_by_request = {demand.request_id: demand for demand in demands}
    eligible_by_request = {
        ranking.request_id: {candidate.provider_id for candidate in ranking.candidates}
        for ranking in rankings
    }

    accepted: list[Assignment] = []
    violations = 0

    # Çözüm içi durum, atamalar **zaman sırasına** göre işlenerek biriktirilir.
    scheduled_by_provider: dict[UUID, list[Assignment]] = {}
    used_capacity: dict[tuple[UUID, date], int] = {}
    capacity_limit: dict[tuple[UUID, date], int] = {}

    for assignment in sorted(
        assignments, key=lambda item: (item.scheduled_start, str(item.request_id))
    ):
        demand = demand_by_request.get(assignment.request_id)
        if demand is None:
            violations += 1
            continue

        if assignment.provider_id not in eligible_by_request.get(assignment.request_id, set()):
            # Elenen (veya hiç değerlendirilmemiş) bir sağlayıcı atanmış.
            violations += 1
            continue

        candidate = next(
            (item for item in demand.candidates if item.provider_id == assignment.provider_id),
            None,
        )
        if candidate is None:
            violations += 1
            continue

        scheduled = Interval(start=assignment.scheduled_start, end=assignment.scheduled_end)
        if scheduled.minutes != demand.duration_minutes:
            violations += 1
            continue

        if not any(
            interval.contains(scheduled) for interval in feasible_intervals(demand, candidate)
        ):
            violations += 1
            continue

        # Kapasite: gün anahtarı, modeldekiyle **aynı** kuralla hesaplanır (talep
        # penceresinin başladığı yerel gün). Doğrulayıcı farklı bir kural kullansaydı
        # çözücü ile denetleyici aynı çözüm hakkında farklı karar verirdi.
        day = demand.window.start.astimezone(service_timezone).date()
        key = (assignment.provider_id, day)
        limit = remaining_capacity(candidate)
        capacity_limit[key] = min(capacity_limit.get(key, limit), limit)
        if used_capacity.get(key, 0) >= capacity_limit[key]:
            violations += 1
            continue

        # Çözüm içi çakışma.
        if _collides(assignment, scheduled_by_provider.get(assignment.provider_id, [])):
            violations += 1
            continue

        used_capacity[key] = used_capacity.get(key, 0) + 1
        scheduled_by_provider.setdefault(assignment.provider_id, []).append(assignment)
        accepted.append(assignment)

    # Çağıran sıralamaya güvenmemeli ama kararlı bir sıra beklemeli.
    accepted.sort(key=lambda item: str(item.request_id))
    return tuple(accepted), violations


def _collides(assignment: Assignment, existing: list[Assignment]) -> bool:
    """Aynı sağlayıcıya atanmış başka bir hizmetle zaman olarak çakışıyor mu?

    Burada **yalnızca örtüşme** aranır, aradaki yol süresi aranmaz — ve bu bilinçli
    bir sınırdır. Yol tamponu, iki hizmet noktası arasındaki mesafeye bağlıdır;
    doğrulayıcı onu yeniden hesaplamaya kalkarsa modelin kullandığı rota
    sağlayıcısını taklit etmiş, yani modelin kendi çıktısını kendi varsayımıyla
    denetlemiş olur. İlk denemede tam olarak bu oldu: elde bulunan tek süre
    (ev→hizmet yolu) iki hizmet arası yol sanıldı ve **geçerli** çözümler ihlalli
    sayıldı.

    Örtüşme ise mesafeden bağımsız, her koşulda geçersizdir: bir sağlayıcı aynı anda
    iki evde olamaz. Yol tamponunun doğrulaması, rota sağlayıcısının elde olduğu
    benchmark denetleyicisine aittir (`evaluation/matching/metrics.py`).
    """
    return any(
        assignment.scheduled_start < other.scheduled_end
        and other.scheduled_start < assignment.scheduled_end
        for other in existing
    )


def _unassigned_for(
    demands: tuple[BookingDemand, ...],
    rankings: tuple[RequestRanking, ...],
    assignments: tuple[Assignment, ...],
    reported: tuple[Unassigned, ...],
) -> tuple[Unassigned, ...]:
    """Atanmamış talepleri, doğrulama sonrası hâle göre yeniden kurar.

    Doğrulayıcı bir atamayı düşürdüyse o talep de atanmamış sayılmalı; aksi hâlde
    sonuç "atandı ama ortada atama yok" gibi okunurdu.
    """
    assigned = {assignment.request_id for assignment in assignments}
    reasons = {item.request_id: item.reason for item in reported}
    candidates_by_request = {ranking.request_id: len(ranking.candidates) for ranking in rankings}

    return tuple(
        Unassigned(
            request_id=demand.request_id,
            reason=reasons.get(
                demand.request_id,
                UnassignedReason.NO_ELIGIBLE_CANDIDATE
                if candidates_by_request.get(demand.request_id, 0) == 0
                else UnassignedReason.NO_FEASIBLE_SCHEDULE,
            ),
        )
        for demand in demands
        if demand.request_id not in assigned
    )


def solve_request(
    request: SolveRequest,
    *,
    algorithm_version: str,
    weights_version: str,
    objective_version: str,
    service_timezone: timezone,
    max_distance_meters: int,
    time_limit_seconds: float,
    router: RoutingProvider | None = None,
) -> SolveResult:
    """Talep kümesini uçtan uca çözer."""
    weights = get_weights(weights_version)
    # Talepler **kanonik sıraya** alınır.
    #
    # Eşit amaç değerli çözümler arasında çözücü, değişkenleri hangi sırada kurduysa
    # ona göre seçer. Kapasite yüzünden üç talepten yalnızca ikisi atanabiliyorsa
    # "hangi müşteri boşta kalır" sorusunun cevabı listenin sırası olurdu — aynı kümeyi
    # farklı sırada göndermek farklı sonuç verirdi. Core zaten sıralı gönderiyor ama
    # determinizm çağıranın nezaketine bırakılamaz (T-17).
    demands = tuple(sorted(request.demands, key=lambda demand: str(demand.request_id)))
    active_router = (
        router
        if router is not None
        else FallbackRouter(primary=get_router("haversine"), fallback=HaversineRouter())
    )

    scoring_started = time.monotonic()
    rankings = tuple(
        rank_demand(
            demand,
            weights=weights,
            router=active_router,
            max_distance_meters=max_distance_meters,
        )
        for demand in demands
    )
    scoring_ms = int((time.monotonic() - scoring_started) * 1000)

    routing_degraded = isinstance(active_router, FallbackRouter) and active_router.degraded
    routing_provider = active_router.name

    if not request.optimize:
        return SolveResult(
            algorithm_version=algorithm_version,
            weights_version=weights_version,
            objective_version=objective_version,
            strategy=SolveStrategy.RANKING_ONLY,
            degraded=routing_degraded,
            degraded_reason=DegradedReason.ROUTING_UNAVAILABLE if routing_degraded else None,
            routing_provider=routing_provider,
            rankings=rankings,
            assignments=(),
            unassigned=(),
            scoring_runtime_ms=scoring_ms,
        )

    outcome = optimize(
        demands,
        rankings,
        router=active_router,
        service_timezone=service_timezone,
        time_limit_seconds=time_limit_seconds,
        objective_version=objective_version,
    )

    degraded_reason: DegradedReason | None = None

    if outcome.status in (SolverStatus.OPTIMAL, SolverStatus.FEASIBLE):
        strategy = SolveStrategy.OPTIMIZED
        assignments = outcome.assignments
        reported_unassigned = outcome.unassigned
        if outcome.status is SolverStatus.FEASIBLE:
            # `FEASIBLE`, CP-SAT dilinde tam olarak şu demektir: "zaman limiti doldu,
            # bir çözüm var ama en iyi olduğu **kanıtlanamadı**". Bunu `OPTIMIZED` ve
            # bozulmamış olarak raporlamak, bozulmayı ölçülemez kılardı — üretimde
            # "kararların yüzde kaçı zaman limitine takıldı" sorusu yanıtsız kalırdı
            # (ADR-0018 §4). Atama geçerlidir; iddia edilen yalnızca en iyilik değildir.
            degraded_reason = DegradedReason.OPTIMIZATION_TIMEOUT
    else:
        # Zaman aşımı, infeasible veya çözücü hatası: sistem cevapsız kalmaz,
        # deterministik sıralamadan açgözlü atama yapılır ve sonuç işaretlenir.
        strategy = SolveStrategy.RANKED_FALLBACK
        assignments, reported_unassigned = greedy.assign(
            demands,
            rankings,
            router=active_router,
            service_timezone=service_timezone,
        )
        degraded_reason = {
            SolverStatus.TIMEOUT: DegradedReason.OPTIMIZATION_TIMEOUT,
            SolverStatus.INFEASIBLE: DegradedReason.OPTIMIZATION_INFEASIBLE,
            SolverStatus.ERROR: DegradedReason.OPTIMIZATION_ERROR,
        }[outcome.status]

    verified, violations = _verify(
        demands, rankings, assignments, service_timezone=service_timezone
    )

    if degraded_reason is None and (
        isinstance(active_router, FallbackRouter) and active_router.degraded
    ):
        degraded_reason = DegradedReason.ROUTING_UNAVAILABLE

    return SolveResult(
        algorithm_version=algorithm_version,
        weights_version=weights_version,
        objective_version=objective_version,
        strategy=strategy,
        degraded=degraded_reason is not None,
        degraded_reason=degraded_reason,
        routing_provider=active_router.name,
        rankings=rankings,
        assignments=verified,
        unassigned=_unassigned_for(demands, rankings, verified, reported_unassigned),
        constraint_violations=violations,
        scoring_runtime_ms=scoring_ms,
        optimization_runtime_ms=outcome.runtime_ms,
    )
