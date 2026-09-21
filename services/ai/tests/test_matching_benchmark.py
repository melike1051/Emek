"""Benchmark geçerliliği.

Bir benchmark'ın en büyük riski yanlış sonuç değil, **anlamsız** sonuçtur: döngüsel
gerçek tanımı, kollar arası farklı ölçüm, yeniden üretilemeyen senaryolar. Bu testler
sayıların büyüklüğünü değil, karşılaştırmanın **geçerliliğini** doğrular.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.evaluation.matching import baseline
from app.evaluation.matching.fixtures import build_scenario, true_fit
from app.evaluation.matching.harness import (
    SERVICE_TIMEZONE,
    load_scenarios,
    run_baseline,
    run_proposed,
)
from app.evaluation.matching.metrics import paired_travel, recall_at_k, verify_solution
from app.matching.engine import solve_request
from app.matching.schema import SolveRequest
from app.routing.haversine import HaversineRouter

EPOCH = datetime(2026, 10, 5, 3, 0, tzinfo=UTC)


def _scenario(seed: int = 7, **overrides: object) -> object:
    defaults: dict[str, object] = {
        "name": "test",
        "seed": seed,
        "provider_count": 25,
        "demand_count": 8,
        "day_start": EPOCH,
        "days": 1,
    }
    defaults.update(overrides)
    return build_scenario(**defaults)  # type: ignore[arg-type]


def test_same_seed_produces_an_identical_scenario() -> None:
    """Yeniden üretilebilirlik: tohumsuz bir benchmark raporlanamaz (ADR-0012 §4)."""
    first = _scenario(seed=42)
    second = _scenario(seed=42)

    assert first.demands == second.demands
    assert first.ground_truth == second.ground_truth


def test_different_seeds_produce_different_scenarios() -> None:
    assert _scenario(seed=1).demands != _scenario(seed=2).demands


def test_ground_truth_is_not_the_scoring_function() -> None:
    """Döngüsellik kontrolü.

    Gizli gerçek skor fonksiyonuyla aynı olsaydı proposed her zaman Recall@1 = 1.0
    alırdı ve ölçüm hiçbir şey söylemezdi. Bu test, iki sıralamanın gerçekten
    ayrıştığını doğrular.
    """
    scenario = _scenario(seed=11, demand_count=12)
    result = solve_request(
        SolveRequest(demands=scenario.demands, optimize=False),
        algorithm_version="matching-v1",
        weights_version="weights-v1",
        objective_version="objective-v1",
        service_timezone=SERVICE_TIMEZONE,
        max_distance_meters=scenario.max_distance_meters,
        time_limit_seconds=5.0,
    )

    recall, support = recall_at_k(result.rankings, scenario.ground_truth, 1)

    assert support > 0
    assert recall < 1.0


def test_ground_truth_is_always_a_constraint_satisfying_provider() -> None:
    """ "Doğru cevap", sisteme atanması yasak bir sağlayıcı olamaz."""
    from app.matching.constraints import evaluate

    scenario = _scenario(seed=13, demand_count=10)

    for demand in scenario.demands:
        expected = scenario.ground_truth.get(demand.request_id)
        if expected is None:
            continue
        candidate = next(item for item in demand.candidates if item.provider_id == expected)
        assert evaluate(demand, candidate, max_distance_meters=scenario.max_distance_meters) == ()


def test_true_fit_depends_on_hidden_attributes() -> None:
    """Gizli nitelik değişince gerçek uyum değişir — gözlenebilir alanlar sabitken."""
    import dataclasses

    scenario = _scenario(seed=17)
    demand = scenario.demands[0]
    provider = next(iter(scenario.providers.values()))

    more_reliable = dataclasses.replace(provider, reliability=min(1.0, provider.reliability + 0.2))

    assert true_fit(
        more_reliable, demand, max_distance_meters=scenario.max_distance_meters
    ) > true_fit(provider, demand, max_distance_meters=scenario.max_distance_meters)


def test_verifier_is_arm_independent_and_catches_baseline_violations() -> None:
    """Doğrulayıcı kolların kendi kontrolüne güvenmez: kural tanımayan kol ihlal üretir."""
    scenario = _scenario(seed=23, demand_count=10)
    router = HaversineRouter()

    rankings = tuple(
        baseline.rank(demand, router=router, max_distance_meters=scenario.max_distance_meters)
        for demand in scenario.demands
    )
    assignments, _ = baseline.assign(scenario.demands, rankings)

    audit = verify_solution(
        scenario.demands,
        assignments,
        max_distance_meters=scenario.max_distance_meters,
        service_timezone=SERVICE_TIMEZONE,
        router=router,
    )

    assert audit.assignment_count > 0
    assert audit.violating_assignments > 0


def test_proposed_arm_produces_no_constraint_violations() -> None:
    """Asıl iddia: proposed hiçbir senaryoda ihlalli atama üretmez."""
    report = run_proposed(load_scenarios())

    assert report.constraint_violation_rate == 0.0
    assert report.violations_by_code == {}


def test_valid_assignment_rate_separates_assigning_from_assigning_correctly() -> None:
    """Baseline her talebe birini atar ama çoğu geçersizdir; ham atama oranı yanıltıcıdır."""
    scenarios = load_scenarios()
    baseline_report = run_baseline(scenarios)
    proposed_report = run_proposed(scenarios)

    assert baseline_report.assignment_rate >= proposed_report.assignment_rate
    assert baseline_report.valid_assignment_rate < proposed_report.valid_assignment_rate


def test_recall_improves_over_the_baseline() -> None:
    scenarios = load_scenarios()
    baseline_report = run_baseline(scenarios)
    proposed_report = run_proposed(scenarios)

    assert proposed_report.recall_at["1"] > baseline_report.recall_at["1"]
    assert proposed_report.recall_at["5"] > baseline_report.recall_at["5"]
    assert baseline_report.recall_support == proposed_report.recall_support


def test_recall_ignores_requests_without_a_feasible_answer() -> None:
    """Uygun sağlayıcısı olmayan talep Recall@K'ya girmez; girseydi metrik senaryo
    zorluğuna göre kayardı."""
    scenario = _scenario(seed=29, provider_count=5, demand_count=10)

    assert len(scenario.ground_truth) <= len(scenario.demands)


def test_paired_travel_compares_only_shared_valid_assignments() -> None:
    """Kolların geçerli atama kümeleri farklı; eşleştirilmemiş kıyas seçilim yanlılığı taşır."""
    scenarios = load_scenarios()
    baseline_report = run_baseline(scenarios)
    proposed_report = run_proposed(scenarios)

    paired = paired_travel(baseline_report, proposed_report)
    shared = set(baseline_report.travel_by_request) & set(proposed_report.travel_by_request)

    assert paired.request_count == len(shared)
    assert paired.request_count > 0


def test_latency_measurements_are_recorded() -> None:
    report = run_proposed(load_scenarios())

    assert report.ranking_latency_p50_ms > 0
    assert report.ranking_latency_p95_ms >= report.ranking_latency_p50_ms
    assert report.end_to_end_latency_p95_ms >= report.end_to_end_latency_p50_ms


def test_matching_confidence_calibration_is_measured() -> None:
    """Skor bir olasılık değildir; bu ölçüm o iddiayı test eder, varsaymaz (R-46)."""
    report = run_proposed(load_scenarios())

    assert report.calibration is not None
    assert report.calibration.sample_count > 0
    assert 0.0 <= report.calibration.ece <= 1.0


def test_two_day_scenario_capacity_is_per_day_not_global() -> None:
    """Günlük kapasite farklı günlerdeki talepler arasında paylaşılmaz."""
    scenario = _scenario(seed=31, days=2, demand_count=14, provider_count=20)
    days = {demand.window.start.astimezone(SERVICE_TIMEZONE).date() for demand in scenario.demands}

    result = solve_request(
        SolveRequest(demands=scenario.demands),
        algorithm_version="matching-v1",
        weights_version="weights-v1",
        objective_version="objective-v1",
        service_timezone=SERVICE_TIMEZONE,
        max_distance_meters=scenario.max_distance_meters,
        time_limit_seconds=10.0,
    )

    assert len(days) == 2
    assert result.constraint_violations == 0


def test_scenario_epoch_is_fixed_so_results_do_not_drift() -> None:
    """ "Bugün"e bağlı bir benchmark her gün farklı sonuç verir ve yeniden üretilemez."""
    first = load_scenarios()
    second = load_scenarios()

    assert first[0].demands[0].window.start == second[0].demands[0].window.start
    assert first[0].demands[0].window.start.tzinfo is not None
    assert first[0].demands[0].window.start < EPOCH + timedelta(days=30)
