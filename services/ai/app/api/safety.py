"""Güvenlik anomali endpoint'i.

Servis **skor üretir ama karar vermez** (ADR-0002, ADR-0019 §7): yanıtta risk
seviyesi, alarm ya da aksiyon alanı yoktur. Core skoru kendi deterministik
kurallarının yanında destekleyici sinyal olarak kullanır; panik bu uca hiç gelmez.

Uç, NLP ve matching uçlarıyla aynı paylaşılan sır kontrolünden geçer.
Girdi (konum türevi sinyaller) loglanmaz.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api.dependencies import ServiceKeyGuard
from app.config import Settings, get_settings
from app.routing.registry import get_router
from app.safety import service
from app.safety.schema import AnomalyRequest, AnomalyResponse

router = APIRouter(tags=["safety"], dependencies=[ServiceKeyGuard])


@router.post("/safety/anomaly", response_model=AnomalyResponse)
def anomaly(payload: AnomalyRequest) -> AnomalyResponse:
    settings: Settings = get_settings()
    return service.assess(
        payload,
        router=get_router(settings.routing_provider),
        model_version=settings.anomaly_model_version,
    )
