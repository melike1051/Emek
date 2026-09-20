"""Kayıtlı parser sürümleri.

Tek bir yerde kurulur: sürüm listesi hem API hem evaluation harness tarafından
kullanılır ve ikisinin farklı sürüm kümesi görmesi deney sonuçlarını yanlış
sürüme atfetmeye yol açardı.
"""

from __future__ import annotations

from app.nlp.baseline import BaselineParser
from app.nlp.heuristic import HeuristicParser
from app.nlp.parser import ParserRegistry, RequestParser

_REGISTRY = ParserRegistry()
_REGISTRY.register(BaselineParser())
_REGISTRY.register(HeuristicParser())


def get_parser(version: str) -> RequestParser:
    """Sürüme karşılık gelen parser. Bilinmeyen sürümde hata verir."""
    return _REGISTRY.get(version)


def available_versions() -> tuple[str, ...]:
    return _REGISTRY.versions()
