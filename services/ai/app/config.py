"""AI servisi yapılandırması.

Core API ile aynı ilke: eksik veya geçersiz ortam değişkeninde servis başlamaz.
Yarım yapılandırılmış bir servisin ayakta kalması hatayı ilk isteğe kadar saklar.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta, timezone
from functools import lru_cache
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.safety.model import MODEL_VERSION, MODEL_VERSIONS

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

    # Hizmet saatlerinin yorumlandığı zaman dilimi ofseti.
    #
    # Core API'deki `SERVICE_TIMEZONE_OFFSET` ile **aynı** değeri taşımak zorundadır:
    # iki servis farklı bir "bugün" tanımı kullanırsa, "bugün temizlik" diyen müşteri
    # için NLP bir gün, core başka bir gün hesaplar. UTC gününü kullanmak aynı hatanın
    # sessiz hâliydi — yerel saat 00:00-03:00 arasında sunucu hâlâ "dün"ü gösteriyordu
    # ve matching (Faz 7) geçmişe düşen bir pencere için aday arıyordu.
    service_timezone_offset: str = Field(
        default="+03:00",
        pattern=r"^[+-][0-9]{2}:[0-9]{2}$",
    )

    # Matching kararlarının sürüm etiketleri (ADR-0012 §1). Her biri sonuçla birlikte
    # saklanır; değişiklik yeni sürüm numarası üretir.
    matching_algorithm_version: str = Field(default="matching-v1", min_length=1, max_length=64)
    matching_weights_version: str = Field(default="weights-v1", min_length=1, max_length=64)
    optimization_objective_version: str = Field(default="objective-v1", min_length=1, max_length=64)

    # Güvenlik anomali modelinin sürümü (ADR-0012, ADR-0019). Her değerlendirme
    # kaydı bu etiketi taşır; model ya da referans aralıkları değişirse sürüm artar.
    # Kayıtlı sürümlerden biri olmak zorundadır (aşağıdaki doğrulama) ve seçilen
    # sürüm **gerçekten** o modeli çalıştırır: etiketi değiştirip modeli
    # değiştirmemek, kaydı yalan söyler hâle getirirdi.
    anomaly_model_version: str = Field(default=MODEL_VERSION, min_length=1, max_length=64)

    # Optimizasyon zaman limiti. Aşıldığında çözüm **atılmaz**: o ana kadarki en iyi
    # uygun çözüm kullanılır, hiç çözüm yoksa deterministik sıralamaya düşülür (T-16).
    optimization_time_limit_seconds: float = Field(default=5.0, gt=0.0, le=60.0)
    # Tek çalıştırmada değerlendirilecek üst sınırlar: kombinatoryal patlama koruması (R-16).
    optimization_max_bookings: int = Field(default=50, ge=1, le=500)
    optimization_max_candidates_per_booking: int = Field(default=50, ge=1, le=500)

    # Mutlak mesafe üst sınırı. Hizmet bölgesi poligonu "evet" dese bile bu sınır
    # aşılamaz: yanlış çizilmiş tek bir poligon şehirler arası atama üretebilirdi.
    matching_max_distance_meters: int = Field(default=50_000, ge=1_000, le=500_000)

    # Routing sağlayıcısı. `haversine` dış servise hiç çıkmaz ve her zaman kullanılabilir;
    # gerçek yol ağı sağlayıcıları aynı portun arkasına takılır (ADR-0002).
    routing_provider: Literal["haversine"] = "haversine"

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

    @property
    def service_timezone(self) -> timezone:
        """Ofset dizesinden timezone nesnesi.

        Sabit ofset yeterlidir: Türkiye 2016'dan beri yaz saati uygulamıyor.
        TODO(verify): yaz saati geri gelirse veya başka bir ülkeye açılırsa IANA
        zaman dilimi (Europe/Istanbul) ile değiştirilmeli — core tarafındaki
        `SERVICE_TIMEZONE_OFFSET` ile birlikte.
        """
        sign = 1 if self.service_timezone_offset[0] == "+" else -1
        hours = int(self.service_timezone_offset[1:3])
        minutes = int(self.service_timezone_offset[4:6])
        return timezone(sign * timedelta(hours=hours, minutes=minutes))

    def today(self) -> date:
        """Hizmet zaman dilimindeki bugünün tarihi.

        `datetime.now(UTC).date()` değildir: yerel gece yarısı ile UTC gece yarısı
        arasındaki üç saatte iki tanım ayrışır ve kullanıcının "bugün"ü bir gün
        geriye kayar.
        """
        return datetime.now(UTC).astimezone(self.service_timezone).date()

    @model_validator(mode="after")
    def _anomaly_version_matches_model(self) -> Settings:
        if self.anomaly_model_version not in MODEL_VERSIONS:
            raise ValueError(
                f"AI_ANOMALY_MODEL_VERSION ({self.anomaly_model_version}) kayıtlı bir modelle "
                f"({', '.join(MODEL_VERSIONS)}) eşleşmiyor: sürüm etiketi modeli tanımlamalı"
            )
        return self

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
