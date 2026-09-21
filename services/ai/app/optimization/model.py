"""OR-Tools CP-SAT atama modeli.

Çözülen problem "her talebe en yüksek skorlu sağlayıcıyı ver" **değildir**. O yaklaşım
tek talebi doğru, talep kümesini yanlış çözer: aynı sağlayıcı üç talebin de en iyisi
olabilir ama günde ikisini alabilir, üstelik aralarında yol vardır. Bu yüzden atama
küresel bir problem olarak kurulur (ADR-0007 §5):

- her talep en fazla bir sağlayıcıya atanır (atanmamak da geçerli bir sonuçtur),
- her sağlayıcı günlük kapasitesini aşamaz,
- aynı sağlayıcının iki hizmeti üst üste binemez ve **aralarındaki yol süresi**
  kadar boşluk olmak zorundadır,
- her hizmet, sağlayıcının müsait olduğu bir aralığın **tamamen içinde** başlar
  ve biter.

Amaç fonksiyonu: atanan talep sayısını (öncelikli) ve toplam skoru maksimize etmek,
toplam seyahat süresini cezalandırmak. Ağırlıklar `objective_version` ile sürümlenir.

**Atanamamak bir hata değildir.** Model "her talep atanmalı" deseydi tek bir uygun
olmayan talep tüm çözümü INFEASIBLE yapardı ve diğer talepler de atanmazdı.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from enum import StrEnum
from uuid import UUID

from ortools.sat.python import cp_model

from app.matching.constraints import feasible_intervals, remaining_capacity
from app.matching.schema import (
    Assignment,
    BookingDemand,
    CandidateFeatures,
    Interval,
    RankedCandidate,
    RequestRanking,
    Unassigned,
    UnassignedReason,
)
from app.optimization.objective import ObjectiveConfig, get_objective
from app.routing.port import RoutingProvider


class SolverStatus(StrEnum):
    """Çözücü sonucu — dış dünyaya sızan tek çözücü detayı."""

    OPTIMAL = "OPTIMAL"
    FEASIBLE = "FEASIBLE"
    INFEASIBLE = "INFEASIBLE"
    TIMEOUT = "TIMEOUT"
    ERROR = "ERROR"


@dataclass(frozen=True)
class OptimizationOutcome:
    """Optimizasyon sonucu.

    `assignments` boş olabilir: hiçbir talebin atanamadığı bir çözüm de geçerli bir
    çözümdür (uygun aday yoksa).
    """

    status: SolverStatus
    assignments: tuple[Assignment, ...]
    unassigned: tuple[Unassigned, ...]
    runtime_ms: int
    #: Çözümde ihlal edilen kısıt sayısı. Model kurgusu gereği her zaman 0 olmalıdır;
    #: sıfırdan farklı bir değer doğrulayıcının bir hata yakaladığı anlamına gelir.
    violations: int = 0


@dataclass(frozen=True)
class _Eligible:
    """Bir (talep, aday) çifti için modele giren hazır veriler."""

    demand_index: int
    provider_id: UUID
    rank: int
    score: float
    intervals: tuple[Interval, ...]
    home_travel_minutes: int
    distance_meters: int
    travel_seconds: int


def _minutes_since(origin: datetime, moment: datetime) -> int:
    return int((moment - origin).total_seconds() // 60)


def _service_date(moment: datetime, tz: timezone) -> date:
    return moment.astimezone(tz).date()


def _candidate_index(demand: BookingDemand) -> dict[UUID, CandidateFeatures]:
    return {candidate.provider_id: candidate for candidate in demand.candidates}


def _travel_minutes(
    origin_demand: BookingDemand,
    target_demand: BookingDemand,
    router: RoutingProvider,
) -> int:
    """İki hizmet noktası arası yol süresi (dakika, yukarı yuvarlanır).

    Yukarı yuvarlama bilinçlidir: aşağı yuvarlamak, sağlayıcının yetişemeyeceği bir
    takvimi uygun göstermek demektir.
    """
    estimate = router.estimate(origin_demand.location, target_demand.location)
    return -(-estimate.duration_seconds // 60)


def solve(
    demands: tuple[BookingDemand, ...],
    rankings: tuple[RequestRanking, ...],
    *,
    router: RoutingProvider,
    service_timezone: timezone,
    time_limit_seconds: float,
    objective_version: str = "objective-v1",
) -> OptimizationOutcome:
    """Talep kümesini birlikte çözer."""
    started = time.monotonic()
    objective: ObjectiveConfig = get_objective(objective_version)

    ranking_by_request = {ranking.request_id: ranking for ranking in rankings}
    # Zaman kökü **dakikaya yuvarlanır**. Model dakika cinsinden tam sayı çalışır ve
    # `_minutes_since` aşağı yuvarlar; saniye taşıyan bir kök, çözücünün aralık
    # başlangıcından 59 saniye **önce** bir başlangıç önermesine izin verirdi.
    # Doğrulayıcı onu reddeder ve geçerli bir çözüm ihlal olarak sayılırdı.
    origin = min(demand.window.start for demand in demands).replace(second=0, microsecond=0)

    eligible: list[_Eligible] = []
    for index, demand in enumerate(demands):
        ranking = ranking_by_request.get(demand.request_id)
        if ranking is None:
            continue
        candidates = _candidate_index(demand)
        for ranked in ranking.candidates:
            candidate = candidates.get(ranked.provider_id)
            if candidate is None:
                continue
            intervals = feasible_intervals(demand, candidate)
            if not intervals:
                continue
            eligible.append(
                _Eligible(
                    demand_index=index,
                    provider_id=ranked.provider_id,
                    rank=ranked.rank,
                    score=ranked.overall_score,
                    intervals=intervals,
                    home_travel_minutes=-(-ranked.travel_seconds // 60),
                    distance_meters=ranked.distance_meters,
                    travel_seconds=ranked.travel_seconds,
                )
            )

    if not eligible:
        return OptimizationOutcome(
            status=SolverStatus.OPTIMAL,
            assignments=(),
            unassigned=tuple(
                Unassigned(
                    request_id=demand.request_id,
                    reason=UnassignedReason.NO_ELIGIBLE_CANDIDATE,
                )
                for demand in demands
            ),
            runtime_ms=int((time.monotonic() - started) * 1000),
        )

    model = cp_model.CpModel()

    starts = [
        model.new_int_var(
            _minutes_since(origin, demand.window.start),
            _minutes_since(origin, demand.window.end) - demand.duration_minutes,
            f"start_{index}",
        )
        for index, demand in enumerate(demands)
    ]

    assign: dict[tuple[int, UUID], cp_model.IntVar] = {}
    objective_terms: list[cp_model.LinearExpr] = []

    for item in eligible:
        demand = demands[item.demand_index]
        literal = model.new_bool_var(f"assign_{item.demand_index}_{item.provider_id}")
        assign[(item.demand_index, item.provider_id)] = literal

        # Başlangıç, adayın müsait olduğu aralıklardan **birinin** içinde olmalı.
        # Aralıklar ayrık olduğu için "hepsinin içinde" denemez; seçim değişkeni gerekir.
        interval_literals: list[cp_model.IntVar] = []
        for position, interval in enumerate(item.intervals):
            chosen = model.new_bool_var(f"slot_{item.demand_index}_{item.provider_id}_{position}")
            interval_literals.append(chosen)
            lower = _minutes_since(origin, interval.start)
            upper = _minutes_since(origin, interval.end) - demand.duration_minutes
            model.add(starts[item.demand_index] >= lower).only_enforce_if(chosen)
            model.add(starts[item.demand_index] <= upper).only_enforce_if(chosen)
        model.add(sum(interval_literals) == 1).only_enforce_if(literal)
        model.add(sum(interval_literals) == 0).only_enforce_if(literal.Not())

        objective_terms.append(
            literal
            * (
                objective.assignment_bonus
                + round(item.score * objective.score_scale)
                - objective.rank_tiebreak * item.rank
                - objective.travel_penalty_per_minute * item.home_travel_minutes
            )
        )

    # Her talep en fazla bir sağlayıcıya.
    for index in range(len(demands)):
        literals = [
            literal for (demand_index, _), literal in assign.items() if demand_index == index
        ]
        if literals:
            model.add(sum(literals) <= 1)

    # Kapasite, **sağlayıcı ve gün** bazındadır: farklı günlerdeki talepler aynı
    # günlük kapasiteyi tüketmez.
    capacity_groups: dict[tuple[UUID, date], list[cp_model.IntVar]] = {}
    capacity_limits: dict[tuple[UUID, date], int] = {}
    for item in eligible:
        demand = demands[item.demand_index]
        day = _service_date(demand.window.start, service_timezone)
        key = (item.provider_id, day)
        capacity_groups.setdefault(key, []).append(assign[(item.demand_index, item.provider_id)])
        candidate = _candidate_index(demand)[item.provider_id]
        limit = remaining_capacity(candidate)
        # Aynı sağlayıcı birden fazla talepte aday olabilir; kalan kapasitenin en
        # muhafazakâr değeri alınır (core farklı anlarda okumuş olabilir).
        capacity_limits[key] = min(capacity_limits.get(key, limit), limit)

    for key, literals in capacity_groups.items():
        model.add(sum(literals) <= capacity_limits[key])

    # Aynı sağlayıcıya atanan iki hizmet: üst üste binemez ve aralarında yol süresi olmalı.
    by_provider: dict[UUID, list[int]] = {}
    for item in eligible:
        by_provider.setdefault(item.provider_id, []).append(item.demand_index)

    travel_terms: list[cp_model.LinearExpr] = []
    for provider_id, indexes in by_provider.items():
        unique_indexes = sorted(set(indexes))
        for position, first in enumerate(unique_indexes):
            for second in unique_indexes[position + 1 :]:
                first_literal = assign[(first, provider_id)]
                second_literal = assign[(second, provider_id)]

                forward = model.new_bool_var(f"before_{provider_id}_{first}_{second}")
                forward_travel = _travel_minutes(demands[first], demands[second], router)
                backward_travel = _travel_minutes(demands[second], demands[first], router)

                model.add(
                    starts[second]
                    >= starts[first] + demands[first].duration_minutes + forward_travel
                ).only_enforce_if([first_literal, second_literal, forward])
                model.add(
                    starts[first]
                    >= starts[second] + demands[second].duration_minutes + backward_travel
                ).only_enforce_if([first_literal, second_literal, forward.Not()])

                # Yol süresi amaç fonksiyonuna yalnızca **iki hizmet de** bu
                # sağlayıcıya atandığında girmeli; aksi hâlde serbest kalan yön
                # değişkeni bedava ceza üretirdi.
                both_forward = model.new_bool_var(f"pair_fwd_{provider_id}_{first}_{second}")
                both_backward = model.new_bool_var(f"pair_bwd_{provider_id}_{first}_{second}")
                model.add_bool_and([first_literal, second_literal, forward]).only_enforce_if(
                    both_forward
                )
                model.add_bool_or(
                    [first_literal.Not(), second_literal.Not(), forward.Not()]
                ).only_enforce_if(both_forward.Not())
                model.add_bool_and([first_literal, second_literal, forward.Not()]).only_enforce_if(
                    both_backward
                )
                model.add_bool_or(
                    [first_literal.Not(), second_literal.Not(), forward]
                ).only_enforce_if(both_backward.Not())

                travel_terms.append(
                    both_forward * (objective.travel_penalty_per_minute * forward_travel)
                )
                travel_terms.append(
                    both_backward * (objective.travel_penalty_per_minute * backward_travel)
                )

    model.maximize(sum(objective_terms) - sum(travel_terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit_seconds
    # Tek iş parçacığı ve sabit tohum: çok iş parçacıklı arama aynı girdi için farklı
    # (eşit değerli) çözümler döndürebilir ve determinizm iddiası (T-17) kaybolurdu.
    solver.parameters.num_workers = 1
    solver.parameters.random_seed = 0

    try:
        status = solver.solve(model)
    except Exception:
        return OptimizationOutcome(
            status=SolverStatus.ERROR,
            assignments=(),
            unassigned=(),
            runtime_ms=int((time.monotonic() - started) * 1000),
        )

    runtime_ms = int((time.monotonic() - started) * 1000)

    if status == cp_model.INFEASIBLE:
        return OptimizationOutcome(
            status=SolverStatus.INFEASIBLE,
            assignments=(),
            unassigned=(),
            runtime_ms=runtime_ms,
        )

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        # UNKNOWN: zaman limiti içinde hiçbir uygun çözüm bulunamadı.
        return OptimizationOutcome(
            status=SolverStatus.TIMEOUT,
            assignments=(),
            unassigned=(),
            runtime_ms=runtime_ms,
        )

    assignments: list[Assignment] = []
    assigned_requests: set[UUID] = set()

    for item in sorted(eligible, key=lambda entry: (entry.demand_index, str(entry.provider_id))):
        literal = assign[(item.demand_index, item.provider_id)]
        if not solver.boolean_value(literal):
            continue
        demand = demands[item.demand_index]
        start_minutes = solver.value(starts[item.demand_index])
        scheduled_start = origin + timedelta(minutes=start_minutes)
        assignments.append(
            Assignment(
                request_id=demand.request_id,
                provider_id=item.provider_id,
                scheduled_start=scheduled_start,
                scheduled_end=scheduled_start + timedelta(minutes=demand.duration_minutes),
                travel_seconds=item.travel_seconds,
                distance_meters=item.distance_meters,
                rank=item.rank,
            )
        )
        assigned_requests.add(demand.request_id)

    unassigned = tuple(
        Unassigned(
            request_id=demand.request_id,
            reason=(
                UnassignedReason.NO_ELIGIBLE_CANDIDATE
                if not ranking_by_request.get(demand.request_id)
                or not ranking_by_request[demand.request_id].candidates
                else UnassignedReason.CAPACITY_EXHAUSTED
            ),
        )
        for demand in demands
        if demand.request_id not in assigned_requests
    )

    return OptimizationOutcome(
        status=SolverStatus.OPTIMAL if status == cp_model.OPTIMAL else SolverStatus.FEASIBLE,
        assignments=tuple(assignments),
        unassigned=unassigned,
        runtime_ms=runtime_ms,
        violations=0,
    )


def horizon_minutes(demands: tuple[BookingDemand, ...]) -> int:
    """Modelin zaman ufku (dakika) — kapasite planlama ve test için."""
    # Zaman kökü **dakikaya yuvarlanır**. Model dakika cinsinden tam sayı çalışır ve
    # `_minutes_since` aşağı yuvarlar; saniye taşıyan bir kök, çözücünün aralık
    # başlangıcından 59 saniye **önce** bir başlangıç önermesine izin verirdi.
    # Doğrulayıcı onu reddeder ve geçerli bir çözüm ihlal olarak sayılırdı.
    origin = min(demand.window.start for demand in demands).replace(second=0, microsecond=0)
    return max(_minutes_since(origin, demand.window.end) for demand in demands)


__all__ = [
    "OptimizationOutcome",
    "RankedCandidate",
    "SolverStatus",
    "horizon_minutes",
    "solve",
]
