"""Katalog ↔ şema slug sözleşmesi.

`StructuredRequest` ve `BookingDemand`, hizmet türünü ve yetkinlikleri **kapalı bir
`Literal` kümesi** olarak tanımlar. Bu, prompt injection savunmasının temeli (Faz 6)
ve matching sözleşmesinin güvenlik sınırı (ADR-0018). Ama kapalı küme, katalogdan
bağımsız yaşarsa sessizce bayatlar.

Somut senaryo: katalog seed'ine dokuzuncu bir hizmet eklenir, buradaki `Literal`
güncellenmez. O hizmeti isteyen her talep motorda 422 alır; core bunu artık
`ENGINE_CONTRACT_MISMATCH` olarak ayırt ediyor (daha önce "servis kapalı" sanıyordu)
ama yine de o hizmet **kalıcı olarak** yalnızca mesafeye göre eşleşir.

Bu test o sessizliği kırar. Zinciri tamamlayan diğer halka core tarafındadır:
`services/api/test/matching.integration.spec.ts`, seed sonrası veritabanındaki
slug'ların bu dosyayla aynı olduğunu doğrular.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import get_args

from app.nlp.schema import Requirement, ServiceType

MANIFEST = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "api-contracts"
    / "matching"
    / "catalog-slugs.json"
)


def _manifest() -> dict[str, list[str]]:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def test_service_literals_match_the_catalog_manifest() -> None:
    assert set(get_args(ServiceType)) == set(_manifest()["serviceSlugs"])


def test_skill_literals_match_the_catalog_manifest() -> None:
    assert set(get_args(Requirement)) == set(_manifest()["skillSlugs"])


def test_manifest_has_no_duplicates() -> None:
    manifest = _manifest()

    for key in ("serviceSlugs", "skillSlugs"):
        assert len(manifest[key]) == len(set(manifest[key])), key
