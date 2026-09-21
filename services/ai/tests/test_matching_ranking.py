"""Sıralama determinizmi, beraberlik çözümü ve açıklanabilirlik (T-17, T-19)."""

from __future__ import annotations

from app.matching.explain import explain
from app.matching.ranking import rank_demand
from app.matching.schema import ExplanationCode, SkillLevel
from app.matching.scoring import components_for
from app.matching.weights import get_weights
from app.routing.haversine import HaversineRouter
from tests.matching_factories import candidate, demand, provider_id

MAX_DISTANCE = 50_000
ROUTER = HaversineRouter()
WEIGHTS = get_weights("weights-v1")


def _rank(*candidates: object) -> list:
    ranking = rank_demand(
        demand(candidates=tuple(candidates)),
        weights=WEIGHTS,
        router=ROUTER,
        max_distance_meters=MAX_DISTANCE,
    )
    return list(ranking.candidates)


def test_ranking_is_ordered_by_descending_score() -> None:
    ranked = _rank(
        candidate(1, distance_meters=30_000),
        candidate(2, distance_meters=1_000),
        candidate(3, distance_meters=15_000),
    )

    assert [entry.provider_id for entry in ranked] == [
        provider_id(2),
        provider_id(3),
        provider_id(1),
    ]
    assert [entry.rank for entry in ranked] == [1, 2, 3]


def test_identical_input_produces_identical_ranking(  # T-17
) -> None:
    """Determinizm: aynı girdi + aynı sürüm → aynı sıralama, aynı skorlar."""
    candidates = (
        candidate(1, distance_meters=4_000),
        candidate(2, distance_meters=9_000, rating_avg=4.9, rating_count=30),
        candidate(3, distance_meters=2_500, quality_score=0.4),
    )

    first = rank_demand(
        demand(candidates=candidates),
        weights=WEIGHTS,
        router=ROUTER,
        max_distance_meters=MAX_DISTANCE,
    )
    second = rank_demand(
        demand(candidates=candidates),
        weights=WEIGHTS,
        router=ROUTER,
        max_distance_meters=MAX_DISTANCE,
    )

    assert first == second


def test_candidate_input_order_does_not_change_the_ranking() -> None:
    """Aday havuzunun geliş sırası sonucu etkilemez; etkileseydi determinizm iddiası
    yalnızca "aynı sırayla gönderirsen" koşuluyla geçerli olurdu."""
    first = candidate(1, distance_meters=4_000)
    second = candidate(2, distance_meters=9_000)
    third = candidate(3, distance_meters=2_500)

    forward = _rank(first, second, third)
    backward = _rank(third, second, first)

    assert [entry.provider_id for entry in forward] == [entry.provider_id for entry in backward]
    assert [entry.overall_score for entry in forward] == [entry.overall_score for entry in backward]


def test_score_ties_are_broken_deterministically_by_provider_id() -> None:
    """Tamamen eşit iki aday: sıra rastgele değil, açık bir kuralla belirlenir."""
    ranked = _rank(candidate(7), candidate(3))

    assert ranked[0].overall_score == ranked[1].overall_score
    assert [entry.provider_id for entry in ranked] == [provider_id(3), provider_id(7)]


def test_eliminated_candidates_are_reported_with_reasons() -> None:
    ranking = rank_demand(
        demand(candidates=(candidate(1), candidate(2, verified=False))),
        weights=WEIGHTS,
        router=ROUTER,
        max_distance_meters=MAX_DISTANCE,
    )

    assert len(ranking.eliminated) == 1
    assert ranking.eliminated[0].provider_id == provider_id(2)
    assert ranking.eliminated[0].violations != ()


def test_ranking_carries_earliest_feasible_start() -> None:
    """Optimizasyon çalışmasa bile sıralama takvim açısından anlamlı bilgi taşır."""
    ranked = _rank(candidate(1))

    assert ranked[0].earliest_start == demand().window.start


def test_explanation_codes_are_a_closed_set_with_numeric_values_only() -> None:
    """T-19: açıklama serbest metin taşımaz ve başka kullanıcının verisini içermez."""
    target = demand(preferred_skills=("utu",))
    subject = candidate(
        1,
        verified_skills=("derin-temizlik", "utu"),
        skill_levels={"derin-temizlik": SkillLevel.EXPERT, "utu": SkillLevel.INTERMEDIATE},
    )
    components = components_for(target, subject, max_distance_meters=MAX_DISTANCE)

    reasons = explain(target, subject, components)

    assert reasons != ()
    for reason in reasons:
        assert isinstance(reason.code, ExplanationCode)
        assert reason.value is None or isinstance(reason.value, float)


def test_explanation_distance_is_coarse_enough_to_avoid_triangulation() -> None:
    """Mesafe 1 km kovalarına yuvarlanır.

    Müşterinin birden çok adresi olabilir ve eşleştirmeyi tekrar çalıştırabilir.
    100 m çözünürlükte üç okuma, sağlayıcının referans noktasını dar bir daireye
    indirger (üçleme). Kova bunu kullanışsız hâle getirir.
    """
    for distance, expected in ((1, 1.0), (1_234, 2.0), (2_000, 2.0), (4_999, 5.0)):
        subject = candidate(1, distance_meters=distance)
        components = components_for(demand(), subject, max_distance_meters=MAX_DISTANCE)

        nearby = next(
            reason
            for reason in explain(demand(), subject, components)
            if reason.code is ExplanationCode.NEARBY
        )

        assert nearby.value == expected, f"{distance} m için {expected} bekleniyordu"


def test_explanation_flags_limited_rating_history() -> None:
    subject = candidate(1, rating_avg=5.0, rating_count=1)
    components = components_for(demand(), subject, max_distance_meters=MAX_DISTANCE)

    codes = {reason.code for reason in explain(demand(), subject, components)}

    assert ExplanationCode.LIMITED_RATING_HISTORY in codes
    assert ExplanationCode.HIGH_RATING not in codes
