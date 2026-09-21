"""Emek AI servisi giriş noktası."""

import logging

from fastapi import FastAPI

from app.api.health import router as health_router
from app.api.matching import router as matching_router
from app.api.nlp import router as nlp_router
from app.api.safety import router as safety_router
from app.config import Settings, get_settings

API_PREFIX = "/api/v1"


def create_app() -> FastAPI:
    """Uygulamayı kurar.

    Yapılandırma burada okunur: geçersizse ValidationError ile süreç başlamaz.
    """
    settings: Settings = get_settings()
    logging.basicConfig(level=settings.log_level.upper())

    app = FastAPI(
        title="Emek AI Service",
        version="0.1.0",
        # Production'da şema/dokümantasyon uçları kapalı: gereksiz yüzey açmaz.
        docs_url=None if settings.is_production else "/docs",
        openapi_url=None if settings.is_production else "/openapi.json",
    )
    app.include_router(health_router, prefix=API_PREFIX)
    app.include_router(nlp_router, prefix=API_PREFIX)
    app.include_router(matching_router, prefix=API_PREFIX)
    app.include_router(safety_router, prefix=API_PREFIX)
    return app


app = create_app()
