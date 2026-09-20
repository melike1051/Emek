"""Değerlendirme CLI'ı: `uv run python -m app.evaluation.run`.

Çıktı makine tarafından işlenebilir JSON'dur ve `docs/research/experiments/` altına
işlenir (ADR-0012 §4). Türetilmiş metrikler (slot F1) açıkça serileştirilir:
`asdict` yalnızca alanları alır, property'leri atlar ve rapor sessizce eksik kalırdı.
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict
from typing import Any

from app.evaluation.dataset import load_dataset
from app.evaluation.harness import PROPOSED_VERSION, collect_errors, run_comparison
from app.evaluation.metrics import EvaluationReport
from app.nlp.registry import get_parser


def _serialize(report: EvaluationReport) -> dict[str, Any]:
    payload = asdict(report)
    payload["slots"] = {
        name: {
            "correct": metric.correct,
            "missed": metric.missed,
            "spurious": metric.spurious,
            "wrong": metric.wrong,
            "f1": metric.f1,
        }
        for name, metric in report.slots.items()
    }
    return payload


def main() -> int:
    comparison = run_comparison()

    errors = collect_errors(get_parser(PROPOSED_VERSION), load_dataset())

    payload = {
        "baseline": _serialize(comparison.baseline),
        "proposed": _serialize(comparison.proposed),
        "deltas": comparison.deltas,
        # Hata analizi rapora elle yazılmaz, buradan alınır (review bulgusu H1).
        "proposed_errors": [asdict(error) for error in errors],
    }
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2, default=str))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
