"""Sıralama katmanı.

Sıralama ile optimizasyon **ayrı kavramlardır** ve bu ayrım bilinçlidir:

- Sıralama tek bir talep için adayları karşılaştırır; başka talepleri bilmez.
- Optimizasyon birden fazla talebi birlikte çözer; kapasite ve seyahat nedeniyle
  bir talebin "en iyi" adayı başka bir talebe gidebilir.

Bu yüzden "en yüksek skor kazanır" nihai strateji değildir (ADR-0007 §5). Sıralama
yine de kendi başına değerlidir: optimizasyon çözüm üretemediğinde devreye giren
deterministik yedek yol odur (T-16) ve `booking_match_results` her adayı sırasıyla
saklar.

**Determinizm:** aynı girdi + aynı sürüm → aynı sıralama. Skor 4 haneye yuvarlanır
ve eşitlik `provider_id` ile çözülür. Rastlantısal hiçbir bileşen yoktur.
"""

from __future__ import annotations

from app.matching.constraints import evaluate, feasible_intervals
from app.matching.explain import explain
from app.matching.schema import (
    BookingDemand,
    CandidateFeatures,
    EliminatedCandidate,
    RankedCandidate,
    RequestRanking,
)
from app.matching.scoring import components_for
from app.matching.weights import WeightSet
from app.routing.port import RoutingProvider


def _travel(
    demand: BookingDemand,
    candidate: CandidateFeatures,
    router: RoutingProvider,
) -> tuple[int, int]:
    """(mesafe, süre) — sağlayıcının hizmet bölgesi merkezi varsa oradan hesaplanır.

    Merkez yoksa yalnızca müşteriye olan kuş uçuşu mesafe bilinir; süre o mesafeden
    yaklaşıklanır. İki durumda da mesafe **core'un PostGIS ile ölçtüğü** değerdir;
    rota sağlayıcısının döndürdüğü yol mesafesi yalnızca süre tahmininde kullanılır.
    """
    if candidate.home_location is not None:
        estimate = router.estimate(candidate.home_location, demand.location)
    else:
        estimate = router.estimate_from_distance(candidate.distance_meters)
    return candidate.distance_meters, estimate.duration_seconds


def rank_demand(
    demand: BookingDemand,
    *,
    weights: WeightSet,
    router: RoutingProvider,
    max_distance_meters: int,
) -> RequestRanking:
    """Bir talebin adaylarını eler, skorlar ve sıralar."""
    ranked: list[tuple[float, str, RankedCandidate]] = []
    eliminated: list[EliminatedCandidate] = []

    for candidate in demand.candidates:
        violations = evaluate(demand, candidate, max_distance_meters=max_distance_meters)
        if violations:
            # Hard constraint ihlali skorla telafi edilmez: aday hiç skorlanmaz.
            eliminated.append(
                EliminatedCandidate(provider_id=candidate.provider_id, violations=violations)
            )
            continue

        components = components_for(demand, candidate, max_distance_meters=max_distance_meters)
        overall = weights.combine(components)
        distance_meters, travel_seconds = _travel(demand, candidate, router)
        intervals = feasible_intervals(demand, candidate)

        entry = RankedCandidate(
            provider_id=candidate.provider_id,
            # Sıra numarası sıralamadan sonra atanır; burada geçici bir değer taşır.
            rank=1,
            components=components,
            overall_score=overall,
            explanation=explain(demand, candidate, components),
            distance_meters=distance_meters,
            travel_seconds=travel_seconds,
            earliest_start=intervals[0].start if intervals else None,
        )
        # Eşitlik `provider_id` ile çözülür: kararlı, açık ve makineden bağımsız.
        # "Önce geleni koru" gibi örtük bir kural, aday sırası değiştiğinde
        # sıralamayı da değiştirirdi ve determinizm iddiası kâğıt üstünde kalırdı.
        ranked.append((-overall, str(candidate.provider_id), entry))

    ranked.sort(key=lambda item: (item[0], item[1]))

    candidates = tuple(
        entry.model_copy(update={"rank": position})
        for position, (_, _, entry) in enumerate(ranked, start=1)
    )

    return RequestRanking(
        request_id=demand.request_id,
        candidates=candidates,
        eliminated=tuple(
            sorted(eliminated, key=lambda item: str(item.provider_id)),
        ),
        evaluated_count=len(demand.candidates),
    )
