"""Karşılaştırma tabanı: "basit filtre + mesafe sıralaması + first-available atama".

ADR-0012 §3'te matching ve optimization eksenlerinin baseline'ı budur. Bilinçli
olarak zayıftır ve **iyileştirilmez** (NLP'deki `baseline-v0` ile aynı disiplin):
karşılaştırmanın ölçüsü onun sabitliğine dayanır. Yapay olarak sakatlanmamıştır da —
bir ürünün "önce en yakını göster, kim müsaitse ona ver" biçimindeki ilk sürümü
gerçekten böyle çalışır.

Neyi **yapmadığı** ölçümün asıl konusudur:

- zorunlu yetkinlik kontrolü yok,
- günlük kapasite kontrolü yok,
- aynı sağlayıcının hizmetleri arası çakışma/yol süresi kontrolü yok,
- mutlak mesafe sınırı yok,
- müsaitlik yalnızca "kesişiyor mu" diye bakılır; hizmetin tamamının sığması aranmaz.

Bu eksiklerin sonucu `constraint_violation_rate` olarak ölçülür ve raporlanır.
"""

from __future__ import annotations

from datetime import timedelta

from app.matching.schema import (
    Assignment,
    BookingDemand,
    RankedCandidate,
    RequestRanking,
    ScoreComponents,
    Unassigned,
    UnassignedReason,
)
from app.matching.scoring import distance_score
from app.routing.port import RoutingProvider

BASELINE_ALGORITHM_VERSION = "matching-baseline-v0"

_ZERO = 0.0


def rank(
    demand: BookingDemand,
    *,
    router: RoutingProvider,
    max_distance_meters: int,
) -> RequestRanking:
    """Basit filtre + mesafe sıralaması."""
    entries: list[tuple[int, str, RankedCandidate]] = []

    for candidate in demand.candidates:
        if not candidate.verified or not candidate.offers_service:
            continue
        # "Müsaitlik" burada yalnızca kesişim: hizmetin tamamının sığıp sığmadığına
        # bakılmaz. Naif sürümün tipik hatası budur.
        if not any(window.overlap_minutes(demand.window) > 0 for window in candidate.availability):
            continue

        components = ScoreComponents(
            skill_score=_ZERO,
            availability_score=_ZERO,
            quality_score=_ZERO,
            distance_score=distance_score(candidate, max_distance_meters=max_distance_meters),
            rating_score=_ZERO,
            preference_score=_ZERO,
        )
        estimate = (
            router.estimate(candidate.home_location, demand.location)
            if candidate.home_location is not None
            else router.estimate_from_distance(candidate.distance_meters)
        )
        entries.append(
            (
                candidate.distance_meters,
                str(candidate.provider_id),
                RankedCandidate(
                    provider_id=candidate.provider_id,
                    rank=1,
                    components=components,
                    overall_score=components.distance_score,
                    explanation=(),
                    distance_meters=candidate.distance_meters,
                    travel_seconds=estimate.duration_seconds,
                    earliest_start=None,
                ),
            )
        )

    entries.sort(key=lambda item: (item[0], item[1]))

    return RequestRanking(
        request_id=demand.request_id,
        candidates=tuple(
            entry.model_copy(update={"rank": position})
            for position, (_, _, entry) in enumerate(entries, start=1)
        ),
        eliminated=(),
        evaluated_count=len(demand.candidates),
    )


def assign(
    demands: tuple[BookingDemand, ...],
    rankings: tuple[RequestRanking, ...],
) -> tuple[tuple[Assignment, ...], tuple[Unassigned, ...]]:
    """First-available atama: her talebe en yakın adayı verir, başka hiçbir şeye bakmaz."""
    ranking_by_request = {ranking.request_id: ranking for ranking in rankings}

    assignments: list[Assignment] = []
    unassigned: list[Unassigned] = []

    for demand in sorted(demands, key=lambda item: (item.window.start, str(item.request_id))):
        ranking = ranking_by_request.get(demand.request_id)
        if ranking is None or not ranking.candidates:
            unassigned.append(
                Unassigned(
                    request_id=demand.request_id,
                    reason=UnassignedReason.NO_ELIGIBLE_CANDIDATE,
                )
            )
            continue

        best = ranking.candidates[0]
        candidate = next(item for item in demand.candidates if item.provider_id == best.provider_id)

        # Başlangıç: kesişen ilk müsaitlik penceresinin başı (yoksa talep penceresinin başı).
        overlapping = [
            window
            for window in sorted(candidate.availability, key=lambda item: item.start)
            if window.overlap_minutes(demand.window) > 0
        ]
        start = (
            max(demand.window.start, overlapping[0].start) if overlapping else demand.window.start
        )

        assignments.append(
            Assignment(
                request_id=demand.request_id,
                provider_id=best.provider_id,
                scheduled_start=start,
                scheduled_end=start + timedelta(minutes=demand.duration_minutes),
                travel_seconds=best.travel_seconds,
                distance_meters=best.distance_meters,
                rank=best.rank,
            )
        )

    assignments.sort(key=lambda item: str(item.request_id))
    unassigned.sort(key=lambda item: str(item.request_id))
    return tuple(assignments), tuple(unassigned)
