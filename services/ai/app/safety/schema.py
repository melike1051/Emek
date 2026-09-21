"""Anomali sözleşmesi: core ↔ AI servisi (ADR-0002, ADR-0019 §7).

Matching şemasıyla aynı ilkeler:

1. **Sınır çizer.** Girdi, core'un doğruladığı telemetriden **türetilmiş**
   sinyallerdir. Ham konum dizisi yoktur; koordinat yalnızca varış aşamasında ve
   yalnızca rota tahmini için iki nokta olarak gelir.
2. **Güvenlik sınırı olur.** Serbest metin alanı yoktur, bilinmeyen alan reddedilir
   (``extra="forbid"``), sayısal alanlar aralıklıdır. Kişi kimliği, adres ya da
   oturum kimliği taşınmaz: model kimin hakkında karar verdiğini bilmez ve bilmesine
   gerek yoktur.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.matching.schema import Location

#: Bir haftadan uzun süreler güvenlik oturumunda anlamsızdır; sınır, bozuk girdiyi
#: skora dönüştürmek yerine reddeder.
_MAX_SECONDS = 7 * 24 * 3600
_MAX_COUNT = 1_000_000
_MAX_METERS = 1_000_000

SessionStatus = Literal["ARRIVAL_MONITORING", "ACTIVE"]
GeofenceState = Literal["UNKNOWN", "INSIDE", "OUTSIDE", "BOUNDARY", "INSUFFICIENT_ACCURACY"]


class RouteRequest(BaseModel):
    """Rota tahmini için iki nokta (Faz 7 routing portu)."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    origin: Location
    destination: Location


class AnomalyRequest(BaseModel):
    """Bir güvenlik oturumunun o anki türetilmiş sinyalleri."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    session_status: SessionStatus
    telemetry_interval_seconds: int = Field(ge=5, le=600)
    planned_duration_seconds: int = Field(ge=1, le=_MAX_SECONDS)
    arrival_delay_seconds: int | None = Field(default=None, ge=-_MAX_SECONDS, le=_MAX_SECONDS)
    elapsed_active_seconds: int | None = Field(default=None, ge=0, le=_MAX_SECONDS)

    geofence_state: GeofenceState
    geofence_state_seconds: int | None = Field(default=None, ge=0, le=_MAX_SECONDS)

    seconds_since_telemetry: int | None = Field(default=None, ge=0, le=_MAX_SECONDS)
    telemetry_count: int = Field(ge=0, le=_MAX_COUNT)
    rejected_count: int = Field(ge=0, le=_MAX_COUNT)
    integrity_rejection_count: int = Field(ge=0, le=_MAX_COUNT)
    mock_location_count: int = Field(ge=0, le=_MAX_COUNT)

    last_distance_meters: int | None = Field(default=None, ge=0, le=_MAX_METERS)
    recent_movement_meters: int | None = Field(default=None, ge=0, le=_MAX_METERS)
    recent_window_seconds: int | None = Field(default=None, ge=0, le=_MAX_SECONDS)
    distance_trend_meters: int | None = Field(default=None, ge=-_MAX_METERS, le=_MAX_METERS)
    # Oturum geçmişi (v2): son pencerede 5 dk'yı aşan örnek boşlukları ve içeriden
    # dışarıya kesin çıkışlar. v1 bunları okumaz; alanlar geriye uyumluluk için
    # isteğe bağlıdır.
    recent_long_gap_count: int | None = Field(default=None, ge=0, le=10_000)
    recent_exit_count: int | None = Field(default=None, ge=0, le=10_000)

    route: RouteRequest | None = None

    @model_validator(mode="after")
    def _phase_fields_are_consistent(self) -> AnomalyRequest:
        # Aşama ile alanlar tutarlı olmalı: varış aşamasında "hizmet süresi",
        # hizmet aşamasında "rota" anlamsızdır. Tutarsız girdi, iki servisin
        # sözleşmesinin ayrıştığını gösterir ve skora dönüştürülmez (422).
        if self.session_status == "ACTIVE" and self.route is not None:
            raise ValueError("rota yalnızca varış aşamasında gönderilir")
        if self.session_status == "ARRIVAL_MONITORING" and self.elapsed_active_seconds is not None:
            raise ValueError("hizmet süresi yalnızca aktif aşamada gönderilir")
        return self


class Contribution(BaseModel):
    """Bir özelliğin skora katkısı — açıklanabilirlik."""

    model_config = ConfigDict(frozen=True)

    feature: str
    deviation: float = Field(ge=0.0, le=1.0)
    contribution: float = Field(ge=0.0, le=1.0)


class RouteEstimateOut(BaseModel):
    """Rota tahmini. ``available=False`` ise hiçbir değer uydurulmaz."""

    model_config = ConfigDict(frozen=True)

    available: bool
    provider: str | None = None
    eta_seconds: int | None = Field(default=None, ge=0)
    distance_meters: int | None = Field(default=None, ge=0)


class AnomalyResponse(BaseModel):
    """Model çıktısı. Karar değildir; core'un risk toplamasına girdi olur.

    **Sözleşme:** ``anomaly_score = 1 − Π(1 − contributionᵢ)`` (4 hanede yuvarlanmış).
    Core bunu, kural uyarısıyla **aynı aileden** gelen katkıları çıkarıp modelin
    bağımsız kanıtını yeniden hesaplamak için kullanır (risk-agg-v2). Bu eşitliği
    bozan bir model sürümü sözleşme değişikliğidir.
    """

    model_config = ConfigDict(frozen=True)

    model_version: str
    anomaly_score: float = Field(ge=0.0, le=1.0)
    quality: float = Field(ge=0.0, le=1.0)
    contributions: list[Contribution]
    unavailable_features: list[str]
    route: RouteEstimateOut | None = None
