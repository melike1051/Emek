"""Matching benchmark koşucusu.

İki kol **aynı senaryolar** üzerinde, **aynı doğrulayıcıyla** ölçülür (ADR-0012 §3):

- `baseline`: basit filtre + mesafe sıralaması + first-available atama.
- `proposed`: hard constraints + çok kriterli scoring + deterministik sıralama +
  OR-Tools CP-SAT küresel atama.

Karşılaştırmanın geçerliliği iki şeye dayanır: senaryoların tohumdan üretilmesi
(yeniden üretilebilirlik) ve doğrulayıcının koldan bağımsız olması.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta, timezone
from uuid import UUID

from app.evaluation.calibration import (
    CalibrationReport,
    CalibrationSample,
    expected_calibration_error,
)
from app.evaluation.matching import baseline
from app.evaluation.matching.fixtures import Scenario, acceptance, build_scenario
from app.evaluation.matching.metrics import (
    MatchingReport,
    percentile,
    recall_at_k,
    verify_solution,
)
from app.matching.engine import solve_request
from app.matching.ranking import rank_demand
from app.matching.schema import (
    Assignment,
    RequestRanking,
    SolveRequest,
    SolveStrategy,
)
from app.matching.weights import WEIGHTS_DISTANCE_ONLY, WEIGHTS_V1, get_weights
from app.routing.haversine import HaversineRouter

#: Senaryoların zaman kökü. Sabit: "bugün"e bağlı bir benchmark her gün farklı
#: sonuç verir ve yeniden üretilemez.
SCENARIO_EPOCH = datetime(2026, 10, 5, 3, 0, tzinfo=UTC)

#: Ölçümde kullanılan hizmet zaman dilimi (UTC+03:00) — core ile aynı.
SERVICE_TIMEZONE = timezone(timedelta(hours=3))

BASELINE_ARM = "baseline"
PROPOSED_ARM = "proposed"

PROPOSED_ALGORITHM_VERSION = "matching-v1"
PROPOSED_OBJECTIVE_VERSION = "objective-v1"

MAX_DISTANCE_METERS = 50_000
TIME_LIMIT_SECONDS = 5.0

RECALL_K = (1, 5, 10)


@dataclass(frozen=True)
class ScenarioSpec:
    """Senaryo tanımı. Tohum ve boyutlar rapora aynen girer."""

    name: str
    seed: int
    provider_count: int
    demand_count: int
    days: int


#: Üç zorluk profili: yoğun/küçük, geniş/çok günlü ve seyrek (az sağlayıcı).
#: Tek senaryo, algoritmanın yalnızca o dağılımdaki davranışını ölçerdi.
SCENARIOS: tuple[ScenarioSpec, ...] = (
    ScenarioSpec(
        name="dense-single-day", seed=20260921, provider_count=40, demand_count=12, days=1
    ),
    ScenarioSpec(name="wide-two-day", seed=20260922, provider_count=90, demand_count=30, days=2),
    ScenarioSpec(name="sparse-supply", seed=20260923, provider_count=14, demand_count=18, days=1),
)


def load_scenarios(specs: tuple[ScenarioSpec, ...] = SCENARIOS) -> tuple[Scenario, ...]:
    """Tanımlardan senaryoları üretir."""
    return tuple(
        build_scenario(
            name=spec.name,
            seed=spec.seed,
            provider_count=spec.provider_count,
            demand_count=spec.demand_count,
            day_start=SCENARIO_EPOCH,
            days=spec.days,
            max_distance_meters=MAX_DISTANCE_METERS,
        )
        for spec in specs
    )


@dataclass
class _ArmAccumulator:
    """Senaryolar boyunca biriken ham sayaçlar."""

    demand_count: int = 0
    candidate_total: int = 0
    eligible_total: int = 0
    assignment_count: int = 0
    valid_assignment_count: int = 0
    accepted_count: int = 0
    violating_assignments: int = 0
    violations_by_code: dict[str, int] = field(default_factory=dict)
    first_leg_seconds: int = 0
    first_leg_meters: int = 0
    realized_route_seconds: int = 0
    assigned_rank_total: int = 0
    fallback_runs: int = 0
    run_count: int = 0
    recall_hits: dict[int, int] = field(default_factory=lambda: dict.fromkeys(RECALL_K, 0))
    recall_support: int = 0
    ranking_latencies: list[float] = field(default_factory=list)
    end_to_end_latencies: list[float] = field(default_factory=list)
    optimization_runtimes: list[float] = field(default_factory=list)
    calibration_samples: list[CalibrationSample] = field(default_factory=list)
    travel_by_request: dict[str, tuple[int, int]] = field(default_factory=dict)
    acceptance_by_request: dict[str, bool] = field(default_factory=dict)


def _score_lookup(
    rankings: tuple[RequestRanking, ...],
) -> dict[tuple[UUID, UUID], tuple[float, int]]:
    return {
        (ranking.request_id, candidate.provider_id): (candidate.overall_score, candidate.rank)
        for ranking in rankings
        for candidate in ranking.candidates
    }


def _accumulate(
    accumulator: _ArmAccumulator,
    scenario: Scenario,
    rankings: tuple[RequestRanking, ...],
    assignments: tuple[Assignment, ...],
    *,
    collect_calibration: bool,
) -> None:

    accumulator.demand_count += len(scenario.demands)
    accumulator.candidate_total += sum(ranking.evaluated_count for ranking in rankings)
    accumulator.eligible_total += sum(len(ranking.candidates) for ranking in rankings)

    for k in RECALL_K:
        recall, support = recall_at_k(rankings, scenario.ground_truth, k)
        accumulator.recall_hits[k] += round(recall * support)
        if k == RECALL_K[0]:
            accumulator.recall_support += support

    audit = verify_solution(
        scenario.demands,
        assignments,
        max_distance_meters=scenario.max_distance_meters,
        service_timezone=SERVICE_TIMEZONE,
        router=HaversineRouter(),
    )
    accumulator.violating_assignments += audit.violating_assignments
    accumulator.realized_route_seconds += audit.realized_route_seconds
    for code, count in audit.violations_by_code.items():
        accumulator.violations_by_code[code] = accumulator.violations_by_code.get(code, 0) + count

    scores = _score_lookup(rankings)
    demand_by_request = {demand.request_id: demand for demand in scenario.demands}

    for assignment in assignments:
        accumulator.assignment_count += 1

        # Geçersiz atamalar maliyet ve kabul metriklerine girmez: girseydi kural
        # tanımayan bir kol, hiç yapılamayacak atamalarla "düşük yol maliyeti" ve
        # "yüksek kabul" gösterirdi.
        if assignment.request_id in audit.violating_requests:
            continue

        accumulator.valid_assignment_count += 1
        accumulator.first_leg_seconds += assignment.travel_seconds
        accumulator.first_leg_meters += assignment.distance_meters
        accumulator.travel_by_request[str(assignment.request_id)] = (
            assignment.travel_seconds,
            assignment.distance_meters,
        )
        accumulator.assigned_rank_total += assignment.rank

        demand = demand_by_request[assignment.request_id]
        provider = scenario.providers[assignment.provider_id]
        accepted = acceptance(
            provider,
            demand,
            assignment.scheduled_start,
            max_distance_meters=scenario.max_distance_meters,
        )
        accumulator.acceptance_by_request[str(assignment.request_id)] = accepted
        if accepted:
            accumulator.accepted_count += 1

        if collect_calibration:
            score, _rank = scores.get((assignment.request_id, assignment.provider_id), (0.0, 0))
            expected = scenario.ground_truth.get(assignment.request_id)
            accumulator.calibration_samples.append(
                CalibrationSample(
                    confidence=score,
                    correct=expected is not None and expected == assignment.provider_id,
                )
            )


def _build_report(
    accumulator: _ArmAccumulator,
    *,
    arm: str,
    algorithm_version: str,
    weights_version: str,
    objective_version: str,
    scenario_count: int,
    calibration: CalibrationReport | None,
) -> MatchingReport:

    demands = accumulator.demand_count or 1
    assignments = accumulator.assignment_count
    valid = accumulator.valid_assignment_count

    return MatchingReport(
        arm=arm,
        algorithm_version=algorithm_version,
        weights_version=weights_version,
        objective_version=objective_version,
        scenario_count=scenario_count,
        demand_count=accumulator.demand_count,
        recall_at={
            str(k): round(accumulator.recall_hits[k] / accumulator.recall_support, 4)
            if accumulator.recall_support
            else 0.0
            for k in RECALL_K
        },
        recall_support=accumulator.recall_support,
        mean_candidate_count=round(accumulator.candidate_total / demands, 2),
        mean_eligible_count=round(accumulator.eligible_total / demands, 2),
        assignment_rate=round(assignments / demands, 4),
        valid_assignment_rate=round(valid / demands, 4),
        acceptance_rate=round(accumulator.accepted_count / valid, 4) if valid else 0.0,
        accepted_assignment_rate=round(accumulator.accepted_count / demands, 4),
        constraint_violation_rate=round(accumulator.violating_assignments / assignments, 4)
        if assignments
        else 0.0,
        violations_by_code=dict(sorted(accumulator.violations_by_code.items())),
        total_first_leg_seconds=accumulator.first_leg_seconds,
        total_first_leg_meters=accumulator.first_leg_meters,
        mean_first_leg_seconds=round(accumulator.first_leg_seconds / valid, 2) if valid else 0.0,
        mean_first_leg_meters=round(accumulator.first_leg_meters / valid, 2) if valid else 0.0,
        realized_route_seconds=accumulator.realized_route_seconds,
        ranking_latency_p50_ms=percentile(accumulator.ranking_latencies, 0.50),
        ranking_latency_p95_ms=percentile(accumulator.ranking_latencies, 0.95),
        end_to_end_latency_p50_ms=percentile(accumulator.end_to_end_latencies, 0.50),
        end_to_end_latency_p95_ms=percentile(accumulator.end_to_end_latencies, 0.95),
        optimization_runtime_p50_ms=percentile(accumulator.optimization_runtimes, 0.50),
        optimization_runtime_p95_ms=percentile(accumulator.optimization_runtimes, 0.95),
        fallback_rate=round(accumulator.fallback_runs / accumulator.run_count, 4)
        if accumulator.run_count
        else 0.0,
        mean_assigned_rank=round(accumulator.assigned_rank_total / valid, 2) if valid else 0.0,
        travel_by_request=dict(sorted(accumulator.travel_by_request.items())),
        acceptance_by_request=dict(sorted(accumulator.acceptance_by_request.items())),
        calibration=calibration,
    )


def run_baseline(scenarios: tuple[Scenario, ...]) -> MatchingReport:
    """Baseline kolu."""
    accumulator = _ArmAccumulator()
    router = HaversineRouter()

    for scenario in scenarios:
        started = time.perf_counter()
        rankings: list[RequestRanking] = []
        for demand in scenario.demands:
            demand_started = time.perf_counter()
            rankings.append(
                baseline.rank(
                    demand, router=router, max_distance_meters=scenario.max_distance_meters
                )
            )
            accumulator.ranking_latencies.append((time.perf_counter() - demand_started) * 1000)

        assignments, _ = baseline.assign(scenario.demands, tuple(rankings))
        accumulator.end_to_end_latencies.append((time.perf_counter() - started) * 1000)
        accumulator.run_count += 1

        _accumulate(
            accumulator,
            scenario,
            tuple(rankings),
            assignments,
            collect_calibration=False,
        )

    return _build_report(
        accumulator,
        arm=BASELINE_ARM,
        algorithm_version=baseline.BASELINE_ALGORITHM_VERSION,
        weights_version=WEIGHTS_DISTANCE_ONLY.version,
        objective_version="greedy-first-available-v0",
        scenario_count=len(scenarios),
        calibration=None,
    )


def run_proposed(
    scenarios: tuple[Scenario, ...],
    *,
    arm: str = PROPOSED_ARM,
    objective_version: str = PROPOSED_OBJECTIVE_VERSION,
) -> MatchingReport:
    """Proposed kolu: üretimdeki `solve_request` yolunun aynısı.

    `objective_version` parametresi duyarlılık analizi içindir: aynı senaryolarda
    yalnızca amaç fonksiyonu katsayıları değiştirilerek etkisi ölçülebilir. Varsayılan
    sürüm üretimdekiyle aynıdır; başka bir sürümle çalıştırılan kol rapora **ayrı
    isimle** girer ki sonuç yanlış sürüme atfedilmesin (ADR-0012 §1).
    """
    accumulator = _ArmAccumulator()
    weights = get_weights(WEIGHTS_V1.version)
    router = HaversineRouter()

    for scenario in scenarios:
        # Talep başına sıralama gecikmesi ayrı ölçülür: uçtan uca ölçüm tek bir
        # toplam verir ve "bir talebin sıralaması ne kadar sürüyor" sorusunu
        # yanıtlamaz. Bu ek geçiş yalnızca ölçüm içindir, çözümü üretmez.
        for demand in scenario.demands:
            demand_started = time.perf_counter()
            rank_demand(
                demand,
                weights=weights,
                router=router,
                max_distance_meters=scenario.max_distance_meters,
            )
            accumulator.ranking_latencies.append((time.perf_counter() - demand_started) * 1000)

        started = time.perf_counter()
        result = solve_request(
            SolveRequest(demands=scenario.demands, optimize=True),
            algorithm_version=PROPOSED_ALGORITHM_VERSION,
            weights_version=WEIGHTS_V1.version,
            objective_version=objective_version,
            service_timezone=SERVICE_TIMEZONE,
            max_distance_meters=scenario.max_distance_meters,
            time_limit_seconds=TIME_LIMIT_SECONDS,
        )
        accumulator.end_to_end_latencies.append((time.perf_counter() - started) * 1000)
        accumulator.optimization_runtimes.append(float(result.optimization_runtime_ms))
        accumulator.run_count += 1
        if result.strategy is SolveStrategy.RANKED_FALLBACK:
            accumulator.fallback_runs += 1

        _accumulate(
            accumulator,
            scenario,
            result.rankings,
            result.assignments,
            collect_calibration=True,
        )

    calibration = (
        expected_calibration_error(accumulator.calibration_samples, bin_count=5)
        if accumulator.calibration_samples
        else None
    )

    return _build_report(
        accumulator,
        arm=arm,
        algorithm_version=PROPOSED_ALGORITHM_VERSION,
        weights_version=WEIGHTS_V1.version,
        objective_version=objective_version,
        scenario_count=len(scenarios),
        calibration=calibration,
    )
