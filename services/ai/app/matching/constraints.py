"""Hard constraint değerlendirmesi (ADR-0007 §4).

Kural tektir ve istisnası yoktur: **hard constraint ihlali hiçbir skorla telafi
edilemez.** Bu yüzden eleme, skorlamadan önce ve skorlamadan bağımsız çalışır —
"çok yüksek skorlu ama müsait olmayan" bir aday sıralamaya hiç girmez.

Core adayları zaten SQL'de filtreler. Buradaki değerlendirme o filtrenin tekrarı
değil, **ikinci savunma katmanıdır**: iki servis sürümü ayrıştığında ya da core'da
bir filtre unutulduğunda ihlalli aday burada elenir ve sayaca yazılır.
"""

from __future__ import annotations

from datetime import timedelta

from app.matching.schema import (
    BookingDemand,
    CandidateFeatures,
    ConstraintCode,
    Interval,
)


def feasible_intervals(demand: BookingDemand, candidate: CandidateFeatures) -> tuple[Interval, ...]:
    """Hizmetin **tamamen** içine sığabileceği zaman aralıkları.

    Müsaitlik penceresi talep penceresiyle kesiştirilir; kesişim istenen süreyi
    barındırmıyorsa aralık düşer. Kısmen örtüşen bir pencere yeterli değildir:
    hizmetin tamamı beyan edilmiş müsait saatlerin içinde olmalı (Faz 4 kuralı,
    `availability.isAvailableLocked` ile aynı semantik).

    Dönen aralıklar **başlangıç** aralıklarıdır: `[start, end - duration]` değil,
    hizmetin sığdığı tam kesişimdir; başlangıç seçimi optimizasyonun işidir.
    """
    duration = timedelta(minutes=demand.duration_minutes)
    intervals: list[Interval] = []

    for window in candidate.availability:
        overlap = window.intersect(demand.window)
        if overlap is None:
            continue
        if overlap.end - overlap.start < duration:
            continue
        intervals.append(overlap)

    # Sıralı dönmek determinizm içindir: aynı girdi aynı çıktıyı vermeli.
    return tuple(sorted(intervals, key=lambda interval: (interval.start, interval.end)))


def evaluate(
    demand: BookingDemand,
    candidate: CandidateFeatures,
    *,
    max_distance_meters: int,
) -> tuple[ConstraintCode, ...]:
    """Adayın ihlal ettiği kısıtlar. Boş demet = aday geçerli.

    Tüm ihlaller toplanır, ilkinde durulmaz: bir adayın neden elendiğini tek satırda
    görmek hata ayıklamayı ve ölçümü kolaylaştırır.
    """
    violations: list[ConstraintCode] = []

    if not candidate.verified:
        violations.append(ConstraintCode.PROVIDER_NOT_VERIFIED)

    if not candidate.offers_service:
        violations.append(ConstraintCode.SERVICE_NOT_OFFERED)

    verified = set(candidate.verified_skills)
    if not set(demand.required_skills).issubset(verified):
        # Beyan edilmiş ama **doğrulanmamış** yetkinlik yeterli değildir: hard
        # constraint doğrulanmış yetkinliğe bakar (profiles migration notu).
        violations.append(ConstraintCode.MISSING_REQUIRED_SKILL)

    if candidate.has_conflicting_booking:
        violations.append(ConstraintCode.BOOKING_CONFLICT)

    if not feasible_intervals(demand, candidate):
        violations.append(ConstraintCode.NOT_AVAILABLE)

    if not candidate.within_service_area:
        violations.append(ConstraintCode.OUTSIDE_SERVICE_AREA)

    if candidate.distance_meters > max_distance_meters:
        # Hizmet bölgesi poligonu "evet" dese bile mutlak bir üst sınır vardır:
        # yanlış çizilmiş tek bir poligon, şehirler arası atama üretebilirdi.
        violations.append(ConstraintCode.DISTANCE_LIMIT_EXCEEDED)

    if candidate.daily_booking_count >= candidate.max_daily_bookings:
        violations.append(ConstraintCode.CAPACITY_EXCEEDED)

    return tuple(violations)


def remaining_capacity(candidate: CandidateFeatures) -> int:
    """Sağlayıcının o gün alabileceği ek rezervasyon sayısı (hiç negatif olmaz)."""
    return max(0, candidate.max_daily_bookings - candidate.daily_booking_count)
