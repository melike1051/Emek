"""Skor bileşenleri ve ağırlık sürümleri."""

from __future__ import annotations

from datetime import timedelta

import pytest

from app.matching.schema import Interval, ScoreComponents, SkillLevel
from app.matching.scoring import (
    availability_score,
    components_for,
    distance_score,
    preference_score,
    quality_score,
    rating_score,
    skill_score,
)
from app.matching.weights import WeightSet, available_versions, get_weights
from tests.matching_factories import EPOCH, candidate, demand, window

MAX_DISTANCE = 50_000


def test_all_components_are_within_unit_range() -> None:
    components = components_for(demand(), candidate(1), max_distance_meters=MAX_DISTANCE)

    for value in components.model_dump().values():
        assert 0.0 <= value <= 1.0


def test_skill_score_rewards_depth_not_presence() -> None:
    """Yetkinliğin **varlığı** hard constraint'te ölçülür; skorda **seviye** ayırt eder."""
    expert = skill_score(demand(), candidate(1))
    beginner = skill_score(
        demand(), candidate(1, skill_levels={"derin-temizlik": SkillLevel.BEGINNER})
    )

    assert expert == 1.0
    assert beginner < expert


def test_skill_score_is_neutral_when_no_requirement_is_stated() -> None:
    """Zorunlu yetkinlik yoksa derinlik hakkında kanıt yoktur: ne 1.0 ne 0.0."""
    score = skill_score(demand(required_skills=()), candidate(1))

    assert 0.0 < score < 1.0


def test_availability_score_is_proportional_not_binary() -> None:
    """Tüm pencere boyunca müsait olan, süresi tam yetene göre daha yüksek skor alır."""
    full = availability_score(demand(), candidate(1))
    half = availability_score(
        demand(),
        candidate(
            1,
            availability=(Interval(start=EPOCH, end=EPOCH + timedelta(hours=4)),),
        ),
    )

    assert full == 1.0
    assert half == pytest.approx(0.5, abs=0.01)


def test_availability_score_never_exceeds_one_with_adjacent_windows() -> None:
    """Bitişik pencereler birleştirilir; çift sayılan dakika 1.0'ı aşardı."""
    first = Interval(start=EPOCH, end=EPOCH + timedelta(hours=4))
    second = Interval(start=EPOCH + timedelta(hours=4), end=EPOCH + timedelta(hours=8))

    assert availability_score(demand(), candidate(1, availability=(first, second))) == 1.0


def test_distance_score_decays_to_zero_at_the_limit() -> None:
    assert distance_score(candidate(1, distance_meters=0), max_distance_meters=MAX_DISTANCE) == 1.0
    assert (
        distance_score(candidate(1, distance_meters=MAX_DISTANCE), max_distance_meters=MAX_DISTANCE)
        == 0.0
    )


def test_rating_score_smooths_single_five_star_reviews() -> None:
    """Tek 5 yıldızlı yeni sağlayıcı, 200 değerlendirmeli 4.8'i geçemez.

    Düzeltilmemiş ortalama kullanılsaydı sahte tek bir değerlendirme sıralamayı
    manipüle etmenin en ucuz yolu olurdu.
    """
    newcomer = rating_score(candidate(1, rating_avg=5.0, rating_count=1))
    established = rating_score(candidate(2, rating_avg=4.8, rating_count=200))

    assert newcomer < established


def test_rating_score_uses_prior_when_there_is_no_history() -> None:
    unrated = rating_score(candidate(1, rating_avg=None, rating_count=0))

    assert 0.0 < unrated < 1.0


def test_quality_score_falls_back_to_saturating_experience() -> None:
    saturated = quality_score(candidate(1, quality_score=None, completed_bookings=1_000))
    novice = quality_score(candidate(2, quality_score=None, completed_bookings=2))

    assert saturated == 1.0
    assert novice < saturated


def test_preference_score_is_full_when_nothing_was_requested() -> None:
    """Tercih yoksa karşılanmamış istek de yoktur."""
    assert preference_score(demand(preferred_skills=()), candidate(1)) == 1.0


def test_preference_score_is_partial_credit() -> None:
    score = preference_score(
        demand(preferred_skills=("derin-temizlik", "utu")),
        candidate(1, verified_skills=("derin-temizlik",)),
    )

    assert score == 0.5


def test_weight_sets_must_sum_to_one() -> None:
    with pytest.raises(ValueError, match="toplamı"):
        WeightSet(
            version="broken",
            skill=0.5,
            availability=0.5,
            quality=0.5,
            distance=0.0,
            rating=0.0,
            preference=0.0,
        )


def test_weight_registry_rejects_unknown_versions() -> None:
    """Sessizce varsayılana düşmek kararı yanlış sürüme atfederdi (ADR-0012 §1)."""
    with pytest.raises(KeyError, match="bilinmeyen ağırlık sürümü"):
        get_weights("weights-does-not-exist")

    assert "weights-v1" in available_versions()


def test_combine_is_a_convex_combination() -> None:
    weights = get_weights("weights-v1")
    perfect = ScoreComponents(
        skill_score=1.0,
        availability_score=1.0,
        quality_score=1.0,
        distance_score=1.0,
        rating_score=1.0,
        preference_score=1.0,
    )
    zero = ScoreComponents(
        skill_score=0.0,
        availability_score=0.0,
        quality_score=0.0,
        distance_score=0.0,
        rating_score=0.0,
        preference_score=0.0,
    )

    assert weights.combine(perfect) == 1.0
    assert weights.combine(zero) == 0.0


def test_distance_only_baseline_weights_ignore_everything_else() -> None:
    weights = get_weights("weights-distance-v0")
    components = components_for(
        demand(), candidate(1, distance_meters=25_000), max_distance_meters=MAX_DISTANCE
    )

    assert weights.combine(components) == components.distance_score


def test_window_helper_keeps_scoring_independent_of_wall_clock() -> None:
    """Skor hesabı sistem saatine bağlı değildir: aynı kurgu her zaman aynı sonucu verir."""
    first = components_for(demand(window=window()), candidate(1), max_distance_meters=MAX_DISTANCE)
    second = components_for(demand(window=window()), candidate(1), max_distance_meters=MAX_DISTANCE)

    assert first == second
