"""NLP endpoint sözleşmesi."""

from datetime import date

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import API_PREFIX, create_app
from app.nlp.sanitize import MAX_RAW_TEXT_LENGTH


@pytest.fixture(autouse=True)
def _clear_settings_cache() -> None:
    get_settings.cache_clear()


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


def test_parse_returns_structured_request(client: TestClient) -> None:
    response = client.post(
        f"{API_PREFIX}/nlp/parse",
        json={"raw_text": "Yarın sabah 3 saat ev temizliği", "today": "2026-03-02"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "PARSED"
    assert body["parser_version"] == "heuristic-v1"
    assert body["request"]["service_type"] == "standart-temizlik"
    assert body["request"]["duration_minutes"] == 180
    assert body["request"]["service_date"] == "2026-03-03"


def test_parse_returns_clarifications_when_unsure(client: TestClient) -> None:
    response = client.post(
        f"{API_PREFIX}/nlp/parse",
        json={"raw_text": "Merhaba", "today": "2026-03-02"},
    )

    body = response.json()
    assert body["status"] == "NEEDS_CLARIFICATION"
    assert body["request"] is None
    assert body["clarifications"][0]["field"] == "service_type"


def test_parser_version_can_be_pinned_for_experiments(client: TestClient) -> None:
    """Aynı girdiyi iki sürümle çalıştırabilmek deney için zorunludur (ADR-0012 §3)."""
    payload = {"raw_text": "TEMİZLİĞE İHTİYACIM VAR", "today": "2026-03-02"}

    baseline = client.post(
        f"{API_PREFIX}/nlp/parse?parser_version=baseline-v0", json=payload
    ).json()
    proposed = client.post(
        f"{API_PREFIX}/nlp/parse?parser_version=heuristic-v1", json=payload
    ).json()

    assert baseline["parser_version"] == "baseline-v0"
    assert proposed["parser_version"] == "heuristic-v1"
    # Baseline Türkçe büyük harfi kaçırır, proposed yakalar.
    assert baseline["request"] is None
    assert proposed["request"]["service_type"] == "standart-temizlik"


def test_unknown_parser_version_is_an_error_not_a_silent_default(client: TestClient) -> None:
    with pytest.raises(KeyError):
        client.post(
            f"{API_PREFIX}/nlp/parse?parser_version=gpt-v9",
            json={"raw_text": "temizlik", "today": "2026-03-02"},
        )


def test_oversized_raw_text_is_rejected_at_contract_level(client: TestClient) -> None:
    response = client.post(
        f"{API_PREFIX}/nlp/parse",
        json={"raw_text": "a" * (MAX_RAW_TEXT_LENGTH + 1), "today": "2026-03-02"},
    )

    assert response.status_code == 422


def test_today_defaults_to_server_date(client: TestClient) -> None:
    """`today` verilmezse sunucu günü kullanılır; sonuç yine deterministiktir."""
    response = client.post(f"{API_PREFIX}/nlp/parse", json={"raw_text": "bugün temizlik"})

    body = response.json()
    assert body["request"]["service_date"] == date.today().isoformat()


def test_response_carries_no_decision_fields(client: TestClient) -> None:
    """Servis seçim yapmaz: yanıtta sağlayıcı/fiyat alanı bulunmaz (ADR-0007 §1)."""
    response = client.post(
        f"{API_PREFIX}/nlp/parse",
        json={"raw_text": "yarın sabah temizlik", "today": "2026-03-02"},
    )

    body = response.json()
    for forbidden in ("provider", "provider_id", "price", "price_minor", "booking_id"):
        assert forbidden not in body
        assert forbidden not in body["request"]
