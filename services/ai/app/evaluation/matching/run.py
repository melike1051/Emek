"""Matching benchmark CLI: `uv run python -m app.evaluation.matching.run`.

Çıktı makine tarafından işlenebilir JSON'dur ve `docs/research/experiments/` altına
işlenir (ADR-0012 §4). Rapordaki hiçbir sayı elle yazılmaz: deney raporu bu çıktıdan
üretilir.
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict
from typing import Any

from app.evaluation.matching.harness import (
    MAX_DISTANCE_METERS,
    SCENARIO_EPOCH,
    SCENARIOS,
    TIME_LIMIT_SECONDS,
    load_scenarios,
    run_baseline,
    run_proposed,
)
from app.evaluation.matching.metrics import compare, paired_acceptance, paired_travel


def main() -> int:
    scenarios = load_scenarios()

    baseline_report = run_baseline(scenarios)
    proposed_report = run_proposed(scenarios)
    paired = paired_travel(baseline_report, proposed_report)
    accepted = paired_acceptance(baseline_report, proposed_report)

    # Duyarlılık analizi: yalnızca amaç fonksiyonunun yol cezası değişir. Varsayılanı
    # değiştirmek yerine ölçmek, "iyi görünen katsayıyı seçip varsayılan yapmak"
    # (metric shopping) olmaktan kaçınır — sonuç ayrı bir kol olarak raporlanır.
    sensitivity_report = run_proposed(
        scenarios, arm="proposed-travel-weighted", objective_version="objective-v2-travel"
    )
    sensitivity_paired = paired_travel(proposed_report, sensitivity_report)

    payload: dict[str, Any] = {
        # Deney yapılandırması sonuçla birlikte saklanır: tohumsuz bir sonuç
        # yeniden üretilemez ve raporlanamaz (ADR-0012 §4).
        "configuration": {
            "dataset": "synthetic",
            "epoch": SCENARIO_EPOCH.isoformat(),
            "max_distance_meters": MAX_DISTANCE_METERS,
            "optimization_time_limit_seconds": TIME_LIMIT_SECONDS,
            "scenarios": [asdict(spec) for spec in SCENARIOS],
        },
        "baseline": asdict(baseline_report),
        "proposed": asdict(proposed_report),
        "deltas": compare(baseline_report, proposed_report),
        # Seyahat kıyası eşleştirilmiş kümede yapılır; kolların geçerli atama
        # kümeleri farklı olduğu için ham ortalamalar kıyaslanabilir değildir.
        "paired_travel": {
            **asdict(paired),
            "travel_time_reduction": paired.travel_time_reduction,
            "distance_reduction": paired.distance_reduction,
        },
        "paired_acceptance": {
            **asdict(accepted),
            "baseline_rate": accepted.baseline_rate,
            "proposed_rate": accepted.proposed_rate,
            "delta": accepted.delta,
        },
        "sensitivity": {
            "objective_version": sensitivity_report.objective_version,
            "report": asdict(sensitivity_report),
            "deltas_vs_proposed": compare(proposed_report, sensitivity_report),
            "paired_travel_vs_proposed": {
                **asdict(sensitivity_paired),
                "travel_time_reduction": sensitivity_paired.travel_time_reduction,
                "distance_reduction": sensitivity_paired.distance_reduction,
            },
        },
    }

    sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2, default=str))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
