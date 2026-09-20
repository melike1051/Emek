"""Değerlendirme veri kümesi (ADR-0012 §4).

Gerçek kişisel veri repoya konmaz. Dataset **sentetiktir**: örnekler gerçek talep
kalıplarından esinlenir ama hiçbir gerçek kullanıcı metni, adı veya adresi içermez.

Her örnek `today` alanı taşır: "yarın" gibi göreli ifadeler sabit bir referans güne
göre etiketlenmiştir, yoksa beklenen çıktı her gün değişir ve set kullanılamaz olur.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date
from pathlib import Path

DATASET_PATH = Path(__file__).resolve().parents[2] / "data" / "evaluation" / "requests.jsonl"


@dataclass(frozen=True)
class GoldSlots:
    """Beklenen alanlar. `None`, "metinde yok, çıkarılmamalı" demektir."""

    service_type: str | None
    duration_minutes: int | None
    service_date: date | None
    time_window: tuple[int, int] | None
    requirements: tuple[str, ...]


@dataclass(frozen=True)
class EvaluationExample:
    """Tek bir etiketli örnek."""

    id: str
    raw_text: str
    today: date
    gold: GoldSlots
    #: Beklenen davranış: metin gerçekten belirsizse netleştirme sorulmalı.
    expect_clarification: bool
    #: Örneğin hangi zorluk sınıfına ait olduğu — hata analizi için.
    category: str


def _parse_date(value: str | None) -> date | None:
    return date.fromisoformat(value) if value else None


def load_dataset(path: Path | None = None) -> tuple[EvaluationExample, ...]:
    """JSONL dosyasını okur ve doğrular."""
    source = path or DATASET_PATH
    examples: list[EvaluationExample] = []

    with source.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            stripped = line.strip()
            if not stripped or stripped.startswith("//"):
                continue

            try:
                row = json.loads(stripped)
            except json.JSONDecodeError as error:
                raise ValueError(f"{source}:{line_number} geçersiz JSON") from error

            window = row["gold"].get("time_window")
            examples.append(
                EvaluationExample(
                    id=row["id"],
                    raw_text=row["raw_text"],
                    today=date.fromisoformat(row["today"]),
                    gold=GoldSlots(
                        service_type=row["gold"].get("service_type"),
                        duration_minutes=row["gold"].get("duration_minutes"),
                        service_date=_parse_date(row["gold"].get("service_date")),
                        time_window=(window[0], window[1]) if window else None,
                        requirements=tuple(row["gold"].get("requirements", ())),
                    ),
                    expect_clarification=bool(row.get("expect_clarification", False)),
                    category=row.get("category", "general"),
                )
            )

    if not examples:
        raise ValueError(f"{source} boş: değerlendirme seti olmadan ölçüm yapılamaz")

    ids = [example.id for example in examples]
    if len(set(ids)) != len(ids):
        raise ValueError("dataset tekrar eden id içeriyor")

    return tuple(examples)
