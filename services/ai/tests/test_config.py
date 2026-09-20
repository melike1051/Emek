"""Yapılandırma doğrulaması: geçersiz ortamda servis başlamaz."""

import pytest
from pydantic import ValidationError

from app.config import Settings, get_settings


def test_defaults_are_development() -> None:
    settings = Settings()

    assert settings.environment == "development"
    assert settings.port == 8000
    assert settings.is_production is False
    # Faz 6'da varsayılan sürüm proposed parser oldu; baseline yalnızca
    # karşılaştırma için açıkça istenir.
    assert settings.parser_version == "heuristic-v1"


def test_reads_prefixed_environment_variables(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_ENVIRONMENT", "staging")
    monkeypatch.setenv("AI_PORT", "9100")
    monkeypatch.setenv("AI_PARSER_VERSION", "nlp-v2")

    settings = Settings()

    assert settings.environment == "staging"
    assert settings.port == 9100
    assert settings.parser_version == "nlp-v2"


def test_rejects_unknown_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_ENVIRONMENT", "prod")

    with pytest.raises(ValidationError):
        Settings()


def test_rejects_out_of_range_port(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_PORT", "70000")

    with pytest.raises(ValidationError):
        Settings()


def test_rejects_non_numeric_port(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_PORT", "abc")

    with pytest.raises(ValidationError):
        Settings()


def test_rejects_empty_parser_version(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_PARSER_VERSION", "")

    with pytest.raises(ValidationError):
        Settings()


def test_settings_are_immutable() -> None:
    settings = Settings()

    with pytest.raises(ValidationError):
        settings.environment = "production"  # type: ignore[misc]


def test_production_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_ENVIRONMENT", "production")
    monkeypatch.setenv("AI_SERVICE_API_KEY", "production-grade-service-key")

    assert Settings().is_production is True


def test_get_settings_is_cached(monkeypatch: pytest.MonkeyPatch) -> None:
    get_settings.cache_clear()
    monkeypatch.setenv("AI_ENVIRONMENT", "test")

    first = get_settings()
    second = get_settings()

    assert first is second
    get_settings.cache_clear()
