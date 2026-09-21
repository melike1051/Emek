"""Hard constraint davranışı (T-18).

Asıl iddia tek cümle: **hard constraint ihlali hiçbir skorla telafi edilemez.**
Testler bu iddiayı hem kısıt katmanında hem de "yüksek skorlu ama ihlalli aday"
kurgusuyla sıralama katmanında doğrular.
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from app.matching.constraints import evaluate, feasible_intervals, remaining_capacity
from app.matching.ranking import rank_demand
from app.matching.schema import ConstraintCode, Interval, SkillLevel
from app.matching.weights import get_weights
from app.routing.haversine import HaversineRouter
from tests.matching_factories import EPOCH, candidate, demand, provider_id, window

MAX_DISTANCE = 50_000
ROUTER = HaversineRouter()
WEIGHTS = get_weights("weights-v1")


def _evaluate(**overrides: object) -> tuple[ConstraintCode, ...]:
    target = demand()
    return evaluate(target, candidate(1, **overrides), max_distance_meters=MAX_DISTANCE)


def test_valid_candidate_has_no_violations() -> None:
    assert _evaluate() == ()


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({"verified": False}, ConstraintCode.PROVIDER_NOT_VERIFIED),
        ({"offers_service": False}, ConstraintCode.SERVICE_NOT_OFFERED),
        (
            {"verified_skills": (), "skill_levels": {}},
            ConstraintCode.MISSING_REQUIRED_SKILL,
        ),
        ({"has_conflicting_booking": True}, ConstraintCode.BOOKING_CONFLICT),
        ({"availability": ()}, ConstraintCode.NOT_AVAILABLE),
        ({"within_service_area": False}, ConstraintCode.OUTSIDE_SERVICE_AREA),
        ({"distance_meters": 60_000}, ConstraintCode.DISTANCE_LIMIT_EXCEEDED),
        ({"daily_booking_count": 2, "max_daily_bookings": 2}, ConstraintCode.CAPACITY_EXCEEDED),
    ],
)
def test_each_constraint_is_detected(
    overrides: dict[str, object], expected: ConstraintCode
) -> None:
    assert expected in _evaluate(**overrides)


def test_unverified_skill_does_not_satisfy_requirement() -> None:
    """Beyan edilmiş ama doğrulanmamış yetkinlik hard constraint'i geçmez."""
    violations = _evaluate(
        verified_skills=(),
        # Seviye bilgisi var ama yetkinlik doğrulanmamış: sözleşme gereği
        # `verified_skills` boş olduğunda yetkinlik yok sayılır.
        skill_levels={"derin-temizlik": SkillLevel.EXPERT},
    )
    assert ConstraintCode.MISSING_REQUIRED_SKILL in violations


def test_partial_availability_is_not_enough() -> None:
    """Hizmetin tamamı müsait aralığın içinde olmalı; kısmi örtüşme yetmez."""
    # 2 saatlik tek pencere, 3 saatlik hizmet: kesişim var ama süre sığmıyor.
    short = Interval(start=EPOCH, end=EPOCH + timedelta(hours=2))
    violations = _evaluate(availability=(short,))

    assert ConstraintCode.NOT_AVAILABLE in violations
    assert feasible_intervals(demand(), candidate(1, availability=(short,))) == ()


def test_distance_limit_is_inclusive_at_boundary() -> None:
    """Sınırdaki aday elenmez; sınırın bir metre ötesindeki elenir (coğrafi sınır)."""
    assert ConstraintCode.DISTANCE_LIMIT_EXCEEDED not in _evaluate(distance_meters=MAX_DISTANCE)
    assert ConstraintCode.DISTANCE_LIMIT_EXCEEDED in _evaluate(distance_meters=MAX_DISTANCE + 1)


def test_all_violations_are_collected_not_just_the_first() -> None:
    violations = _evaluate(verified=False, offers_service=False, within_service_area=False)

    assert set(violations) >= {
        ConstraintCode.PROVIDER_NOT_VERIFIED,
        ConstraintCode.SERVICE_NOT_OFFERED,
        ConstraintCode.OUTSIDE_SERVICE_AREA,
    }


def test_remaining_capacity_never_goes_negative() -> None:
    assert remaining_capacity(candidate(1, daily_booking_count=5, max_daily_bookings=2)) == 0


def test_high_score_does_not_rescue_a_violating_candidate() -> None:
    """T-18: mükemmel skor bileşenlerine sahip ama doğrulanmamış aday **elenir**."""
    perfect_but_unverified = candidate(
        1,
        verified=False,
        distance_meters=0,
        rating_avg=5.0,
        rating_count=500,
        quality_score=1.0,
        completed_bookings=1_000,
    )
    weaker_but_valid = candidate(2, distance_meters=30_000, rating_avg=3.0, rating_count=3)

    ranking = rank_demand(
        demand(candidates=(perfect_but_unverified, weaker_but_valid)),
        weights=WEIGHTS,
        router=ROUTER,
        max_distance_meters=MAX_DISTANCE,
    )

    assert [entry.provider_id for entry in ranking.candidates] == [provider_id(2)]
    assert [entry.provider_id for entry in ranking.eliminated] == [provider_id(1)]


def test_zero_eligible_providers_produces_empty_ranking() -> None:
    ranking = rank_demand(
        demand(candidates=(candidate(1, verified=False), candidate(2, availability=()))),
        weights=WEIGHTS,
        router=ROUTER,
        max_distance_meters=MAX_DISTANCE,
    )

    assert ranking.candidates == ()
    assert len(ranking.eliminated) == 2
    assert ranking.evaluated_count == 2


def test_single_eligible_provider_is_ranked_first() -> None:
    ranking = rank_demand(
        demand(candidates=(candidate(1, verified=False), candidate(2))),
        weights=WEIGHTS,
        router=ROUTER,
        max_distance_meters=MAX_DISTANCE,
    )

    assert len(ranking.candidates) == 1
    assert ranking.candidates[0].rank == 1
    assert ranking.candidates[0].provider_id == provider_id(2)


def test_feasible_intervals_are_clipped_to_the_request_window() -> None:
    """Müsaitlik talep penceresinden geniş olsa da hizmet pencere dışına taşamaz."""
    wide = window(start_hour=-4, length_hours=24)
    intervals = feasible_intervals(
        demand(window=window(start_hour=1, length_hours=5)), candidate(1, availability=(wide,))
    )

    assert len(intervals) == 1
    assert intervals[0].start == EPOCH + timedelta(hours=1)
    assert intervals[0].end == EPOCH + timedelta(hours=6)
