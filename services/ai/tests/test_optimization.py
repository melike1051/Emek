"""Küresel atama, kapasite, çakışma, yol süresi ve bozulma davranışı (T-16, T-18)."""

from __future__ import annotations

from datetime import UTC, timedelta, timezone

import pytest

from app.matching import engine
from app.matching.ranking import rank_demand
from app.matching.schema import (
    DegradedReason,
    Interval,
    Location,
    SolveRequest,
    SolveStrategy,
    UnassignedReason,
)
from app.matching.weights import get_weights
from app.optimization import greedy
from app.optimization.model import OptimizationOutcome, SolverStatus
from app.optimization.model import solve as optimize
from app.optimization.objective import available_versions, get_objective
from app.routing.haversine import HaversineRouter
from app.routing.port import RoutingUnavailableError, TravelEstimate
from tests.matching_factories import EPOCH, candidate, demand, provider_id, window

MAX_DISTANCE = 50_000
ROUTER = HaversineRouter()
WEIGHTS = get_weights("weights-v1")
TZ = timezone(timedelta(hours=3))


def solve(*demands: object, **overrides: object) -> object:
    defaults: dict[str, object] = {
        "algorithm_version": "matching-v1",
        "weights_version": "weights-v1",
        "objective_version": "objective-v1",
        "service_timezone": TZ,
        "max_distance_meters": MAX_DISTANCE,
        "time_limit_seconds": 5.0,
    }
    defaults.update(overrides)
    return engine.solve_request(SolveRequest(demands=tuple(demands)), **defaults)  # type: ignore[arg-type]


def test_single_demand_is_assigned_to_the_best_candidate() -> None:
    result = solve(demand(candidates=(candidate(1, distance_meters=20_000), candidate(2))))

    assert result.strategy is SolveStrategy.OPTIMIZED
    assert len(result.assignments) == 1
    assert result.assignments[0].provider_id == provider_id(2)
    assert result.constraint_violations == 0


def test_no_eligible_candidate_leaves_the_request_unassigned() -> None:
    result = solve(demand(candidates=(candidate(1, verified=False),)))

    assert result.assignments == ()
    assert result.unassigned[0].reason is UnassignedReason.NO_ELIGIBLE_CANDIDATE


def test_capacity_limit_is_respected_across_multiple_requests() -> None:
    """Tek sağlayıcı üç talebin de en iyisi; günlük kapasitesi 1."""
    only = candidate(1, max_daily_bookings=1)
    demands = tuple(demand(index, candidates=(only,), duration_minutes=60) for index in range(3))

    result = solve(*demands)

    assert len(result.assignments) == 1
    assert len(result.unassigned) == 2
    assert result.constraint_violations == 0


def test_highest_score_does_not_win_globally() -> None:
    """Aynı sağlayıcı iki talebin de en iyisi ama kapasitesi 1: ikinci talep,
    daha düşük skorlu ama uygun bir sağlayıcıya gider.

    "En yüksek skor kazanır" stratejisi olsaydı ikinci talep sağlayıcısız kalırdı.
    """
    best = candidate(1, distance_meters=500, max_daily_bookings=1)
    second_best = candidate(2, distance_meters=20_000)
    demands = tuple(
        demand(index, candidates=(best, second_best), duration_minutes=60) for index in range(2)
    )

    result = solve(*demands)

    assigned = {assignment.provider_id for assignment in result.assignments}
    assert assigned == {provider_id(1), provider_id(2)}
    assert len(result.assignments) == 2


def test_two_bookings_for_one_provider_do_not_overlap_and_include_travel() -> None:
    far_away = Location(latitude=41.2000, longitude=29.2000)
    shared = candidate(1, max_daily_bookings=2)

    first = demand(0, candidates=(shared,), duration_minutes=120)
    second = demand(
        1,
        candidates=(shared,),
        duration_minutes=120,
        location=far_away,
        # Aynı uzun pencere: çözücünün sıralamayı kendisinin kurması gerekir.
        window=window(length_hours=8),
    )

    result = solve(first, second)

    assert len(result.assignments) == 2
    ordered = sorted(result.assignments, key=lambda item: item.scheduled_start)
    travel = ROUTER.estimate(first.location, far_away).duration_seconds
    gap = (ordered[1].scheduled_start - ordered[0].scheduled_end).total_seconds()

    assert gap >= travel
    assert result.constraint_violations == 0


def test_assignment_always_falls_inside_declared_availability() -> None:
    late_only = Interval(start=EPOCH + timedelta(hours=5), end=EPOCH + timedelta(hours=8))
    result = solve(
        demand(candidates=(candidate(1, availability=(late_only,)),), duration_minutes=180)
    )

    assignment = result.assignments[0]
    assert assignment.scheduled_start >= late_only.start
    assert assignment.scheduled_end <= late_only.end


def test_optimization_timeout_falls_back_to_ranked_assignment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:  # T-16
    """Zaman aşımında sistem cevapsız kalmaz: sıralamadan atama yapılır ve
    sonuç `degraded` işaretlenir. İşaretsiz bir fallback bozulmayı ölçülemez kılardı."""

    def timed_out(*args: object, **kwargs: object) -> OptimizationOutcome:
        return OptimizationOutcome(
            status=SolverStatus.TIMEOUT, assignments=(), unassigned=(), runtime_ms=5_000
        )

    monkeypatch.setattr(engine, "optimize", timed_out)

    result = solve(demand())

    assert result.strategy is SolveStrategy.RANKED_FALLBACK
    assert result.degraded is True
    assert result.degraded_reason is DegradedReason.OPTIMIZATION_TIMEOUT
    assert len(result.assignments) == 1
    assert result.constraint_violations == 0


def test_optimization_infeasible_falls_back_without_losing_the_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def infeasible(*args: object, **kwargs: object) -> OptimizationOutcome:
        return OptimizationOutcome(
            status=SolverStatus.INFEASIBLE, assignments=(), unassigned=(), runtime_ms=12
        )

    monkeypatch.setattr(engine, "optimize", infeasible)

    result = solve(demand())

    assert result.strategy is SolveStrategy.RANKED_FALLBACK
    assert result.degraded_reason is DegradedReason.OPTIMIZATION_INFEASIBLE
    assert len(result.assignments) == 1


def test_solver_error_is_contained_and_reported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def broken(*args: object, **kwargs: object) -> OptimizationOutcome:
        return OptimizationOutcome(
            status=SolverStatus.ERROR, assignments=(), unassigned=(), runtime_ms=1
        )

    monkeypatch.setattr(engine, "optimize", broken)

    result = solve(demand())

    assert result.degraded_reason is DegradedReason.OPTIMIZATION_ERROR
    assert result.constraint_violations == 0


def test_fallback_never_returns_a_constraint_violating_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Bozulma hâlinde de hard constraint kuralı geçerlidir."""

    def timed_out(*args: object, **kwargs: object) -> OptimizationOutcome:
        return OptimizationOutcome(
            status=SolverStatus.TIMEOUT, assignments=(), unassigned=(), runtime_ms=1
        )

    monkeypatch.setattr(engine, "optimize", timed_out)

    result = solve(demand(candidates=(candidate(1, has_conflicting_booking=True), candidate(2))))

    assert [item.provider_id for item in result.assignments] == [provider_id(2)]


def test_verifier_drops_an_assignment_that_violates_constraints(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Doğrulayıcı son savunmadır: model bozulsa bile ihlalli atama dışarı çıkmaz."""
    target = demand(candidates=(candidate(1), candidate(2, verified=False)))

    def forged(*args: object, **kwargs: object) -> OptimizationOutcome:
        from app.matching.schema import Assignment

        return OptimizationOutcome(
            status=SolverStatus.FEASIBLE,
            assignments=(
                Assignment(
                    request_id=target.request_id,
                    # Elenmiş sağlayıcı: hiçbir koşulda atanamaz.
                    provider_id=provider_id(2),
                    scheduled_start=target.window.start,
                    scheduled_end=target.window.start + timedelta(minutes=180),
                    travel_seconds=60,
                    distance_meters=1_000,
                    rank=1,
                ),
            ),
            unassigned=(),
            runtime_ms=3,
        )

    monkeypatch.setattr(engine, "optimize", forged)

    result = solve(target)

    assert result.assignments == ()
    assert result.constraint_violations == 1
    assert result.unassigned[0].request_id == target.request_id


def test_ranking_only_mode_skips_optimization() -> None:
    result = engine.solve_request(
        SolveRequest(demands=(demand(),), optimize=False),
        algorithm_version="matching-v1",
        weights_version="weights-v1",
        objective_version="objective-v1",
        service_timezone=TZ,
        max_distance_meters=MAX_DISTANCE,
        time_limit_seconds=5.0,
    )

    assert result.strategy is SolveStrategy.RANKING_ONLY
    assert result.assignments == ()
    assert result.rankings[0].candidates != ()


def test_optimization_is_deterministic_for_identical_input() -> None:
    """T-17: aynı girdi + aynı sürüm → aynı atama (çözücü tamamlandığında)."""
    demands = tuple(
        demand(index, candidates=(candidate(1, max_daily_bookings=2), candidate(2)))
        for index in range(3)
    )

    first = solve(*demands)
    second = solve(*demands)

    assert [
        (item.request_id, item.provider_id, item.scheduled_start) for item in first.assignments
    ] == [(item.request_id, item.provider_id, item.scheduled_start) for item in second.assignments]


def test_objective_versions_are_registered_and_validated() -> None:
    assert "objective-v1" in available_versions()
    assert (
        get_objective("objective-v1").assignment_bonus > get_objective("objective-v1").score_scale
    )

    with pytest.raises(KeyError, match="bilinmeyen amaç sürümü"):
        get_objective("objective-does-not-exist")


def test_travel_weighted_objective_changes_the_solution_not_its_validity() -> None:
    """Amaç sürümü değişince karar değişebilir; kısıt ihlali yine 0 kalır."""
    demands = tuple(
        demand(
            index,
            candidates=(candidate(1, distance_meters=30_000), candidate(2, distance_meters=800)),
            duration_minutes=120,
        )
        for index in range(2)
    )

    default = solve(*demands)
    travel_weighted = solve(*demands, objective_version="objective-v2-travel")

    assert default.constraint_violations == 0
    assert travel_weighted.constraint_violations == 0
    assert travel_weighted.objective_version == "objective-v2-travel"


def test_routing_failure_degrades_without_losing_the_assignment() -> None:
    """Rota sağlayıcısı düşerse eldeki coğrafi veriyle devam edilir, sonuç işaretlenir."""

    class FailingRouter:
        @property
        def name(self) -> str:
            return "failing"

        def estimate(self, origin: object, destination: object) -> TravelEstimate:
            raise RoutingUnavailableError("rota servisi yok")

        def estimate_from_distance(self, distance_meters: int) -> TravelEstimate:
            raise RoutingUnavailableError("rota servisi yok")

    from app.routing.registry import FallbackRouter

    router = FallbackRouter(primary=FailingRouter(), fallback=HaversineRouter())

    result = engine.solve_request(
        SolveRequest(demands=(demand(),)),
        algorithm_version="matching-v1",
        weights_version="weights-v1",
        objective_version="objective-v1",
        service_timezone=TZ,
        max_distance_meters=MAX_DISTANCE,
        time_limit_seconds=5.0,
        router=router,
    )

    assert result.degraded is True
    assert result.degraded_reason is DegradedReason.ROUTING_UNAVAILABLE
    assert result.routing_provider == "haversine"
    assert len(result.assignments) == 1


def test_real_solver_under_a_tiny_time_limit_still_returns_a_valid_result() -> None:
    """Gerçek çözücü, çok kısa zaman limitinde ne çöker ne de ihlalli sonuç verir."""
    shared = tuple(candidate(index, max_daily_bookings=3) for index in range(1, 12))
    demands = tuple(demand(index, candidates=shared, duration_minutes=90) for index in range(12))

    result = solve(*demands, time_limit_seconds=0.01)

    assert result.constraint_violations == 0
    assert result.strategy in (SolveStrategy.OPTIMIZED, SolveStrategy.RANKED_FALLBACK)


def test_greedy_respects_capacity_and_travel_spacing() -> None:
    """Fallback yolu da kuralları uygular; yalnızca küresel en iyiyi aramaz."""
    shared = candidate(1, max_daily_bookings=2)
    demands = tuple(demand(index, candidates=(shared,), duration_minutes=120) for index in range(3))
    rankings = tuple(
        rank_demand(item, weights=WEIGHTS, router=ROUTER, max_distance_meters=MAX_DISTANCE)
        for item in demands
    )

    assignments, unassigned = greedy.assign(demands, rankings, router=ROUTER, service_timezone=TZ)

    assert len(assignments) == 2
    assert len(unassigned) == 1
    ordered = sorted(assignments, key=lambda item: item.scheduled_start)
    assert ordered[1].scheduled_start >= ordered[0].scheduled_end


def test_optimize_directly_reports_solver_status() -> None:
    demands = (demand(),)
    rankings = tuple(
        rank_demand(item, weights=WEIGHTS, router=ROUTER, max_distance_meters=MAX_DISTANCE)
        for item in demands
    )

    outcome = optimize(
        demands, rankings, router=ROUTER, service_timezone=UTC, time_limit_seconds=5.0
    )

    assert outcome.status in (SolverStatus.OPTIMAL, SolverStatus.FEASIBLE)
    assert outcome.violations == 0


def test_demand_order_does_not_change_the_outcome() -> None:
    """T-17, motor sınırında.

    Kapasite yüzünden üç talepten yalnızca ikisi atanabiliyor ve tüm atama kümeleri
    amaç değeri bakımından eşit. Sıralama kanonikleştirilmeseydi "hangi müşteri boşta
    kalır" sorusunun cevabını listenin sırası verirdi — ve aynı kümeyi farklı sırada
    göndermek farklı sonuç üretirdi. Bu, determinizm iddiasını çağıranın nezaketine
    bağlardı.
    """
    import itertools

    shared = (candidate(1, max_daily_bookings=1), candidate(2, max_daily_bookings=1))
    demands = tuple(demand(index, candidates=shared, duration_minutes=420) for index in range(3))

    outcomes = set()
    for permutation in itertools.permutations(demands):
        result = solve(*permutation)
        outcomes.add(
            tuple(
                sorted((str(item.request_id), str(item.provider_id)) for item in result.assignments)
            )
        )

    assert len(outcomes) == 1


def test_time_limited_solution_is_marked_degraded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`FEASIBLE`, "zaman limiti doldu, en iyilik kanıtlanamadı" demektir.

    Bunu bozulmamış olarak raporlamak, "kararların yüzde kaçı zaman limitine takıldı"
    sorusunu yanıtsız bırakırdı — oysa etiketleme tam bu ölçüm için var (ADR-0018 §4).
    """

    def feasible(*args: object, **kwargs: object) -> OptimizationOutcome:
        from app.matching.schema import Assignment

        target = demand()
        return OptimizationOutcome(
            status=SolverStatus.FEASIBLE,
            assignments=(
                Assignment(
                    request_id=target.request_id,
                    provider_id=provider_id(1),
                    scheduled_start=target.window.start,
                    scheduled_end=target.window.start + timedelta(minutes=180),
                    travel_seconds=60,
                    distance_meters=2_000,
                    rank=1,
                ),
            ),
            unassigned=(),
            runtime_ms=5_000,
        )

    monkeypatch.setattr(engine, "optimize", feasible)

    result = solve(demand())

    # Atama geçerlidir ve korunur; iddia edilmeyen tek şey **en iyilik**tir.
    assert result.strategy is SolveStrategy.OPTIMIZED
    assert result.degraded is True
    assert result.degraded_reason is DegradedReason.OPTIMIZATION_TIMEOUT
    assert len(result.assignments) == 1


def test_verifier_rejects_a_solution_that_exceeds_daily_capacity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Tek tek geçerli, birlikte imkânsız: bir çözücü hatasının tipik biçimi.

    Aday bazlı kontrol bunu göremez — her atamada `daily_booking_count` hâlâ 0'dır.
    Çözüm içi kontrol olmasaydı ihlal `constraint_violations = 0` ile raporlanırdı.
    """
    from app.matching.schema import Assignment

    shared = candidate(1, max_daily_bookings=1)
    demands = tuple(demand(index, candidates=(shared,), duration_minutes=60) for index in range(2))

    def over_capacity(*args: object, **kwargs: object) -> OptimizationOutcome:
        return OptimizationOutcome(
            status=SolverStatus.OPTIMAL,
            assignments=tuple(
                Assignment(
                    request_id=item.request_id,
                    provider_id=provider_id(1),
                    scheduled_start=item.window.start + timedelta(hours=index * 2),
                    scheduled_end=item.window.start + timedelta(hours=index * 2, minutes=60),
                    travel_seconds=60,
                    distance_meters=2_000,
                    rank=1,
                )
                for index, item in enumerate(demands)
            ),
            unassigned=(),
            runtime_ms=3,
        )

    monkeypatch.setattr(engine, "optimize", over_capacity)

    result = solve(*demands)

    assert len(result.assignments) == 1
    assert result.constraint_violations == 1


def test_verifier_rejects_overlapping_assignments_for_one_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Bir sağlayıcı aynı anda iki evde olamaz — mesafeden bağımsız olarak."""
    from app.matching.schema import Assignment

    shared = candidate(1, max_daily_bookings=3)
    demands = tuple(demand(index, candidates=(shared,), duration_minutes=120) for index in range(2))

    def overlapping(*args: object, **kwargs: object) -> OptimizationOutcome:
        return OptimizationOutcome(
            status=SolverStatus.OPTIMAL,
            assignments=tuple(
                Assignment(
                    request_id=item.request_id,
                    provider_id=provider_id(1),
                    # İkisi de aynı saatte.
                    scheduled_start=item.window.start,
                    scheduled_end=item.window.start + timedelta(minutes=120),
                    travel_seconds=60,
                    distance_meters=2_000,
                    rank=1,
                )
                for item in demands
            ),
            unassigned=(),
            runtime_ms=3,
        )

    monkeypatch.setattr(engine, "optimize", overlapping)

    result = solve(*demands)

    assert len(result.assignments) == 1
    assert result.constraint_violations == 1
