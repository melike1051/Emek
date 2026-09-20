"""Health endpoint'leri ve production yüzey kısıtları."""

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import API_PREFIX, create_app


@pytest.fixture(autouse=True)
def _clear_settings_cache() -> None:
    """Her test kendi ortam değişkenleriyle taze bir Settings görür."""
    get_settings.cache_clear()


def test_liveness_returns_ok() -> None:
    with TestClient(create_app()) as client:
        response = client.get(f"{API_PREFIX}/health/live")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_readiness_reports_environment_and_parser_version(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AI_ENVIRONMENT", "staging")
    monkeypatch.setenv("AI_PARSER_VERSION", "nlp-v3")

    with TestClient(create_app()) as client:
        response = client.get(f"{API_PREFIX}/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "environment": "staging",
        "parser_version": "nlp-v3",
    }


def test_endpoints_are_versioned() -> None:
    """Sürümsüz yol yoktur: istemciler yalnızca /api/v1 üzerinden konuşur."""
    with TestClient(create_app()) as client:
        assert client.get("/health").status_code == 404
        assert client.get(f"{API_PREFIX}/health").status_code == 200


def test_docs_are_available_outside_production() -> None:
    with TestClient(create_app()) as client:
        assert client.get("/docs").status_code == 200
        assert client.get("/openapi.json").status_code == 200


def test_docs_are_disabled_in_production(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_ENVIRONMENT", "production")
    monkeypatch.setenv("AI_SERVICE_API_KEY", "production-grade-service-key")

    with TestClient(create_app()) as client:
        assert client.get("/docs").status_code == 404
        assert client.get("/openapi.json").status_code == 404
        # Servis yine çalışır durumdadır.
        assert client.get(f"{API_PREFIX}/health/live").status_code == 200
