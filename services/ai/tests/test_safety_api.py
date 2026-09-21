"""Güvenlik anomali endpoint'i: sözleşme, servis anahtarı ve sürüm yayılımı."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.main import API_PREFIX, create_app
from app.safety.model import MODEL_VERSION

PAYLOAD: dict[str, object] = {
    "session_status": "ACTIVE",
    "telemetry_interval_seconds": 30,
    "planned_duration_seconds": 7200,
    "elapsed_active_seconds": 3600,
    "geofence_state": "OUTSIDE",
    "geofence_state_seconds": 1500,
    "seconds_since_telemetry": 40,
    "telemetry_count": 100,
    "rejected_count": 0,
    "integrity_rejection_count": 0,
    "mock_location_count": 0,
    "last_distance_meters": 900,
    "recent_movement_meters": 800,
    "recent_window_seconds": 1800,
    "distance_trend_meters": 700,
    "recent_long_gap_count": 0,
    "recent_exit_count": 0,
}


@pytest.fixture(autouse=True)
def _clear_settings_cache() -> Iterator[None]:
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


def test_anomaly_endpoint_returns_versioned_score(client: TestClient) -> None:
    response = client.post(f"{API_PREFIX}/safety/anomaly", json=PAYLOAD)

    assert response.status_code == 200
    body = response.json()
    assert body["model_version"] == MODEL_VERSION
    assert 0.0 <= body["anomaly_score"] <= 1.0
    assert 0.0 <= body["quality"] <= 1.0
    assert body["contributions"][0]["feature"] == "outside_dwell"
    # Servis karar vermez: yanıtta risk seviyesi ya da aksiyon alanı yoktur.
    assert "risk_level" not in body
    assert "action" not in body


def test_malformed_payload_is_rejected_as_contract_error(client: TestClient) -> None:
    response = client.post(
        f"{API_PREFIX}/safety/anomaly", json={**PAYLOAD, "session_status": "CLOSED"}
    )

    assert response.status_code == 422


def test_service_key_is_enforced_when_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_SERVICE_API_KEY", "x" * 32)
    get_settings.cache_clear()
    client = TestClient(create_app())

    assert client.post(f"{API_PREFIX}/safety/anomaly", json=PAYLOAD).status_code == 401
    ok = client.post(
        f"{API_PREFIX}/safety/anomaly", json=PAYLOAD, headers={"x-service-key": "x" * 32}
    )
    assert ok.status_code == 200


def test_version_label_must_match_model(monkeypatch: pytest.MonkeyPatch) -> None:
    """Etiketi değiştirip modeli değiştirmemek kaydı yalan söyler hâle getirirdi."""
    monkeypatch.setenv("AI_ANOMALY_MODEL_VERSION", "anomaly-deviation-v9")

    with pytest.raises(ValueError, match="eşleşmiyor"):
        Settings()
