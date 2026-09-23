"""S-09 — Aday sayısı arttıkça optimizasyon davranışı (Faz 14; R-16).

Çalıştırma:
    cd services/ai && uv run python -m app.evaluation.matching.scale

Neden ayrı bir koşu: Faz 7 benchmark'ı (EXP-002) üç sabit zorluk profilinde
**kalite** karşılaştırması yapar (baseline vs proposed). Burada sorulan farklıdır:
aday havuzu büyüdükçe **çalışma süresi, timeout ve fallback** nasıl davranıyor?
R-16'nın açık bıraktığı nokta tam olarak budur.

Ölçüm disiplini:
- Tohum ve boyutlar çıktıya aynen yazılır; tohumsuz sonuç raporlanamaz (ADR-0012 §4).
- Yalnızca `provider_count` değişir; talep sayısı, gün sayısı ve tohum sabittir ki
  gözlenen fark ölçekten gelsin, senaryo değişiminden değil.
- Amaç fonksiyonu/katsayılar **değiştirilmez**. Bu bir performans ölçümüdür;
  "iyi görünen" sonucu üretmek için algoritma ayarlanmaz.
- Kalite metrikleri (geçerli atama oranı, kısıt ihlali) süreyle birlikte raporlanır:
  hızlanıp doğruluktan kaybeden bir kol "iyi" değildir.

Etiket: **local benchmark** — tek makine, emülasyonsuz Python; mutlak süreler
donanıma bağlıdır, taşınabilir olan ölçek eğrisidir.
"""

from __future__ import annotations

import json
import platform
import sys
import time
from typing import Any

from app.evaluation.matching.fixtures import build_scenario
from app.evaluation.matching.harness import (
    MAX_DISTANCE_METERS,
    SCENARIO_EPOCH,
    TIME_LIMIT_SECONDS,
    run_proposed,
)

#: Tohumlar. Her sağlayıcı sayısı **birden çok tohumla** çalıştırılır.
#:
#: İlk koşuda boyut başına tek senaryo vardı ve p50 ile p95 birebir aynı çıkıyordu —
#: yani tek örnekten yüzdelik raporlanıyordu. Tek örnekli bir p95 yüzdelik değildir.
#:
#: İkinci koşuda 5 tohum vardı; o da yetmiyordu (Faz 14 performance review, H-1):
#: `percentile` en-yakın-sıra kullanır, n=5 için p95 → `ceil(0.95*5)-1 = 4`, yani
#: **5 koşunun maksimumu**. "200 adayda p95, zaman limitinin %85'i" gibi yük taşıyan
#: bir cümle 5 koşunun en kötüsüne dayanamaz. n=20'de p95 → index 18, artık gerçek
#: bir üst kuyruk ölçüsüdür.
SEEDS: tuple[int, ...] = tuple(20260923 + offset for offset in range(20))
DEMAND_COUNT = 30
DAYS = 2
PROVIDER_COUNTS: tuple[int, ...] = (40, 90, 200, 400, 800)

#: **Asıl R-16 değişkeni.** Optimizasyonun gördüğü aday sayısı, sağlayıcı nüfusuyla
#: değil bu üst sınırla belirlenir: senaryo üreticisi talep başına en iyi
#: `candidates_per_demand` adayı verir. İlk koşuda yalnızca sağlayıcı sayısı
#: büyütülmüştü ve `mean_candidate_count` her boyutta tam 20.0 çıkıyordu — yani
#: optimizasyonun girdisi hiç büyümemişti ve ölçüm H-4'ü sınamıyordu.
CANDIDATE_LIMITS: tuple[int, ...] = (10, 20, 50, 100, 200)
#: Aday sınırı süpürmesi için sabit ve **bol** sağlayıcı havuzu: aday sayısı
#: arzın yetersizliğiyle değil, sınırla belirlensin.
CANDIDATE_SWEEP_PROVIDERS = 800


def _measure(
    *,
    name: str,
    provider_count: int,
    candidates_per_demand: int,
) -> dict[str, Any]:
    scenarios = tuple(
        build_scenario(
            name=f"{name}-{seed}",
            seed=seed,
            provider_count=provider_count,
            demand_count=DEMAND_COUNT,
            day_start=SCENARIO_EPOCH,
            days=DAYS,
            max_distance_meters=MAX_DISTANCE_METERS,
            candidates_per_demand=candidates_per_demand,
        )
        for seed in SEEDS
    )

    started = time.perf_counter()
    report = run_proposed(scenarios)
    wall_ms = round((time.perf_counter() - started) * 1000, 1)

    return {
        "provider_count": provider_count,
        "candidates_per_demand": candidates_per_demand,
        "seeds": len(SEEDS),
        "demand_count_total": report.demand_count,
        "mean_candidate_count": report.mean_candidate_count,
        "mean_eligible_count": report.mean_eligible_count,
        "optimization_runtime_p50_ms": report.optimization_runtime_p50_ms,
        "optimization_runtime_p95_ms": report.optimization_runtime_p95_ms,
        "end_to_end_latency_p50_ms": report.end_to_end_latency_p50_ms,
        "end_to_end_latency_p95_ms": report.end_to_end_latency_p95_ms,
        "fallback_rate": report.fallback_rate,
        "valid_assignment_rate": report.valid_assignment_rate,
        "constraint_violation_rate": report.constraint_violation_rate,
        # Kalite metrikleri (Faz 14 performance review, H-2).
        #
        # `valid_assignment_rate` bir **kapsama** ölçüsüdür ve 1.0'da tavana vurur:
        # tavana vurduktan sonra daha iyi bir çözümü daha kötüsünden ayırt edemez.
        # "Daha fazla aday kalite kazandırmıyor" iddiası yalnızca bu metriğe
        # dayandırılırsa, "zaten tavana vurmuş tek metrikte kazanç yok" demiş olur.
        # Aşağıdakiler doymaz: hangi sağlayıcının seçildiği ve ne kadar iyi seçildiği
        # aday havuzu büyüdükçe **değişebilir**.
        "recall_at": report.recall_at,
        "acceptance_rate": report.acceptance_rate,
        "accepted_assignment_rate": report.accepted_assignment_rate,
        "mean_assigned_rank": report.mean_assigned_rank,
        "mean_first_leg_meters": report.mean_first_leg_meters,
        "wall_clock_ms": wall_ms,
    }


def main() -> int:
    # --- A: aday sayısı süpürmesi (H-4'ün asıl sorusu) ---
    candidate_rows: list[dict[str, Any]] = []
    for limit in CANDIDATE_LIMITS:
        row = _measure(
            name=f"cand-{limit}",
            provider_count=CANDIDATE_SWEEP_PROVIDERS,
            candidates_per_demand=limit,
        )
        candidate_rows.append(row)
        print(
            f"candidates<={limit:>4} mean={row['mean_candidate_count']:>6} "
            f"opt_p50={row['optimization_runtime_p50_ms']:>8.1f}ms "
            f"opt_p95={row['optimization_runtime_p95_ms']:>8.1f}ms "
            f"fallback={row['fallback_rate']:>5} valid={row['valid_assignment_rate']:>6}",
            file=sys.stderr,
        )

    # --- B: sağlayıcı nüfusu süpürmesi (aday sınırı sabit) ---
    rows: list[dict[str, Any]] = []

    for provider_count in PROVIDER_COUNTS:
        row = _measure(
            name=f"scale-{provider_count}",
            provider_count=provider_count,
            candidates_per_demand=20,
        )
        rows.append(row)
        print(
            f"providers={provider_count:>4} mean_cand={row['mean_candidate_count']:>6} "
            f"opt_p50={row['optimization_runtime_p50_ms']:>8.1f}ms "
            f"opt_p95={row['optimization_runtime_p95_ms']:>8.1f}ms "
            f"fallback={row['fallback_rate']:>5} valid={row['valid_assignment_rate']:>6}",
            file=sys.stderr,
        )

    payload = {
        "experiment": "EXP-007-matching-scale",
        "label": "local benchmark",
        "configuration": {
            "dataset": "synthetic",
            "seeds": list(SEEDS),
            "demand_count_per_scenario": DEMAND_COUNT,
            "days": DAYS,
            "provider_counts": list(PROVIDER_COUNTS),
            "candidate_limits": list(CANDIDATE_LIMITS),
            "candidate_sweep_providers": CANDIDATE_SWEEP_PROVIDERS,
            "epoch": SCENARIO_EPOCH.isoformat(),
            "max_distance_meters": MAX_DISTANCE_METERS,
            "optimization_time_limit_seconds": TIME_LIMIT_SECONDS,
            "python": platform.python_version(),
            "platform": platform.platform(),
        },
        "candidate_sweep": candidate_rows,
        "provider_sweep": rows,
    }
    json.dump(payload, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
