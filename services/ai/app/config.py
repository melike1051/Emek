"""AI servisi yapılandırması.

Core API ile aynı ilke: eksik veya geçersiz ortam değişkeninde servis başlamaz.
Yarım yapılandırılmış bir servisin ayakta kalması hatayı ilk isteğe kadar saklar.
"""

from functools import lru_cache
from typing import Literal

from pydantic import Field
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
    parser_version: str = Field(default="baseline-v0", min_length=1, max_length=64)

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Süreç ömrü boyunca tek Settings örneği.

    Testler bu önbelleği `get_settings.cache_clear()` ile temizler.
    """
    return Settings()
