"""Açgözlü atama.

İki ayrı işi görür ve ikisi de bilinçlidir:

1. **Fallback.** Optimizasyon zaman limitinde çözüm üretemezse veya hata verirse
   sistem cevapsız kalmaz: sıralamadan sırayla atama yapılır ve sonuç `degraded`
   işaretlenir (T-16). Bu yol da hard constraint'leri ve kapasiteyi ihlal etmez —
   yalnızca **küresel en iyiyi** aramaz.
2. **Baseline.** ADR-0012 §3'teki "greedy / first-available atama" karşılaştırma
   tabanı tam olarak budur. Benchmark'ta proposed ile aynı kod yolundan geçer ki
   fark algoritmadan gelsin, ölçüm farkından değil.

Sıra deterministiktir: talepler (pencere başlangıcı, talep kimliği) ile sıralanır.
"Gelen sırayla" işlemek, aynı kümeyi farklı sırada göndermeyi farklı sonuç üretir
hâle getirirdi.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from app.matching.constraints import feasible_intervals, remaining_capacity
from app.matching.schema import (
    Assignment,
    BookingDemand,
    Interval,
    RequestRanking,
    Unassigned,
    UnassignedReason,
)
from app.routing.port import RoutingProvider


def _earliest_start(
    intervals: tuple[Interval, ...],
    duration_minutes: int,
    busy: list[tuple[datetime, datetime]],
) -> datetime | None:
    """Verilen aralıklarda, meşgul bloklarla çakışmayan en erken başlangıç.

    `busy` blokları **yol süresi dâhil** edilmiş hâlde gelir: böylece çakışma
    kontrolü tek bir zaman aralığı karşılaştırmasına iner.
    """
    duration = timedelta(minutes=duration_minutes)

    for interval in intervals:
        candidate_start = interval.start
        # Meşgul bloklar sıralı taranır: bir blokla çakışıyorsa başlangıç bloğun
        # sonuna itilir ve aynı aralıkta yeniden denenir.
        for busy_start, busy_end in sorted(busy):
            if candidate_start + duration <= busy_start:
                break
            if candidate_start < busy_end:
                candidate_start = busy_end
        if candidate_start + duration <= interval.end:
            return candidate_start

    return None


def assign(
    demands: tuple[BookingDemand, ...],
    rankings: tuple[RequestRanking, ...],
    *,
    router: RoutingProvider,
    service_timezone: timezone,
) -> tuple[tuple[Assignment, ...], tuple[Unassigned, ...]]:
    """Sıralamadan açgözlü atama üretir."""
    ranking_by_request = {ranking.request_id: ranking for ranking in rankings}

    #: (sağlayıcı, gün) → o gün atanan rezervasyon sayısı.
    used_capacity: dict[tuple[str, date], int] = {}
    #: Sağlayıcı → o sağlayıcıya atanmış taleplerin konumları (yol süresi için).
    scheduled_demands: dict[str, list[tuple[datetime, datetime, BookingDemand]]] = {}

    assignments: list[Assignment] = []
    unassigned: list[Unassigned] = []

    ordered = sorted(demands, key=lambda demand: (demand.window.start, str(demand.request_id)))

    for demand in ordered:
        ranking = ranking_by_request.get(demand.request_id)
        if ranking is None or not ranking.candidates:
            unassigned.append(
                Unassigned(
                    request_id=demand.request_id,
                    reason=UnassignedReason.NO_ELIGIBLE_CANDIDATE,
                )
            )
            continue

        candidates_by_id = {candidate.provider_id: candidate for candidate in demand.candidates}
        day = demand.window.start.astimezone(service_timezone).date()
        placed = False
        capacity_blocked = False

        for ranked in ranking.candidates:
            provider_key = str(ranked.provider_id)
            candidate = candidates_by_id.get(ranked.provider_id)
            if candidate is None:
                # Sıralama ile aday havuzu ayrışmışsa bu aday atlanır. `KeyError`
                # fırlatmak, yedek yolun kendisini çökertirdi — oysa bu yol tam da
                # bir şeyler ters gittiğinde devreye giriyor.
                continue

            limit = remaining_capacity(candidate)
            if used_capacity.get((provider_key, day), 0) >= limit:
                capacity_blocked = True
                continue

            # Meşgul bloklar, aradaki yol süresi kadar genişletilir: sağlayıcı bir
            # hizmetin bitiminde diğerinin kapısında olamaz.
            busy: list[tuple[datetime, datetime]] = []
            for booked_start, booked_end, other in scheduled_demands.get(provider_key, []):
                travel = router.estimate(other.location, demand.location).duration_seconds
                margin = timedelta(seconds=travel)
                busy.append((booked_start - margin, booked_end + margin))

            start = _earliest_start(
                feasible_intervals(demand, candidate), demand.duration_minutes, busy
            )
            if start is None:
                continue

            end = start + timedelta(minutes=demand.duration_minutes)
            assignments.append(
                Assignment(
                    request_id=demand.request_id,
                    provider_id=ranked.provider_id,
                    scheduled_start=start,
                    scheduled_end=end,
                    travel_seconds=ranked.travel_seconds,
                    distance_meters=ranked.distance_meters,
                    rank=ranked.rank,
                )
            )
            scheduled_demands.setdefault(provider_key, []).append((start, end, demand))
            used_capacity[(provider_key, day)] = used_capacity.get((provider_key, day), 0) + 1
            placed = True
            break

        if not placed:
            unassigned.append(
                Unassigned(
                    request_id=demand.request_id,
                    reason=(
                        UnassignedReason.CAPACITY_EXHAUSTED
                        if capacity_blocked
                        else UnassignedReason.NO_FEASIBLE_SCHEDULE
                    ),
                )
            )

    assignments.sort(key=lambda item: str(item.request_id))
    unassigned.sort(key=lambda item: str(item.request_id))
    return tuple(assignments), tuple(unassigned)
