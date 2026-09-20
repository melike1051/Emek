"""AI servisi yapılandırması.

Core API ile aynı ilke: eksik veya geçersiz ortam değişkeninde servis başlamaz.
Yarım yapılandırılmış bir servisin ayakta kalması hatayı ilk isteğe kadar saklar.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

Environment = Literal["development", "test", "staging", "production"]
LogLevel = Literal["critical", "error", "warning", "info", "debug"]


class Settings(BaseSettings):
    """Ortam değişkenlerinden okunan, doğrulanmış yapılandırma."""

    model_config = SettingsConfigDict(
        env_prefix="AI_",
        extra="ignore",
        frozen=True,
    )

    environment: Environment = "development"
    port: int = Field(default=8000, ge=1, le=65535)
    log_level: LogLevel = "info"

    # Ar-Ge izlenebilirliği: her NLP yanıtı hangi parser sürümüyle üretildiğini taşır (ADR-0012).
    parser_version: str = Field(default="heuristic-v1", min_length=1, max_length=64)

    # Servisler arası paylaşılan sır.
    #
    # AI servisi yalnızca ağ politikasıyla korunuyordu; "deny by default" duruşu
    # (ADR-0013) tek katmanlı bir savunmayla uyuşmuyor. Sır tanımlıysa her istek
    # `x-service-key` başlığı taşımak zorundadır. Production'da tanımlı olmak
    # **zorunludur** (aşağıdaki doğrulama).
    service_api_key: str | None = Field(default=None, min_length=16, max_length=128)

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @model_validator(mode="after")
    def _production_requires_service_key(self) -> Settings:
        if self.is_production and self.service_api_key is None:
            raise ValueError(
                "AI_SERVICE_API_KEY production ortamında tanımlı olmalı: "
                "servis yalnızca ağ politikasına güvenemez"
            )
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Süreç ömrü boyunca tek Settings örneği.

    Testler bu önbelleği `get_settings.cache_clear()` ile temizler.
    """
    return Settings()
