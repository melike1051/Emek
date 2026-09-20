"""Health endpoint'leri.

Faz 1'de AI servisi henüz veritabanı veya Redis kullanmıyor; bu nedenle readiness
yalnızca süreç ve yapılandırma durumunu raporlar. Veritabanı (read-only) bağımlılığı
Faz 6-7'de candidate retrieval ile birlikte gelecek ve o zaman kontrol listesine eklenecek —
kullanılmayan bir bağımlılığı sadece health check için eklemek gereksiz dependency olur.
"""

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

from app.config import Settings, get_settings

router = APIRouter(tags=["health"])


class LivenessResponse(BaseModel):
    status: Literal["ok"]


class ReadinessResponse(BaseModel):
    status: Literal["ok"]
    environment: str
    parser_version: str


@router.get("/health/live", response_model=LivenessResponse)
def live() -> LivenessResponse:
    """Liveness: süreç ayakta mı? Bağımlılık kontrolü yapmaz."""
    return LivenessResponse(status="ok")


@router.get("/health", response_model=ReadinessResponse)
def ready() -> ReadinessResponse:
    """Readiness: yapılandırma geçerli ve servis istek alabilir durumda mı?"""
    settings: Settings = get_settings()
    return ReadinessResponse(
        status="ok",
        environment=settings.environment,
        parser_version=settings.parser_version,
    )
