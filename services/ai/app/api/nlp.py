"""NLP endpoint'i.

Servis **karar vermez**: yalnızca "müşteri ne istiyor?" sorusunu yapılandırılmış
biçimde yanıtlar (ADR-0007 §1). Sağlayıcı seçimi, müsaitlik ve fiyat bu servisin
görüş alanında değildir — bu yüzden yanıtta böyle alanlar yoktur.
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Query
from pydantic import BaseModel, ConfigDict, Field

from app.api.dependencies import ServiceKeyGuard
from app.config import Settings, get_settings
from app.nlp.registry import get_parser
from app.nlp.sanitize import MAX_RAW_TEXT_LENGTH
from app.nlp.schema import ParseResult

# Tüm NLP uçları paylaşılan sır kontrolünden geçer (deny by default, ADR-0013).
router = APIRouter(tags=["nlp"], dependencies=[ServiceKeyGuard])


class ParseRequest(BaseModel):
    """Ayrıştırma isteği."""

    model_config = ConfigDict(frozen=True)

    # Uzunluk sınırı burada da var: sanitize kırpıyor, ama sözleşme seviyesinde
    # reddetmek istemciye net geri bildirim verir ve gereksiz iş yapılmaz.
    raw_text: str = Field(max_length=MAX_RAW_TEXT_LENGTH)
    #: Göreli ifadelerin ("yarın") çözüleceği gün. Verilmezse **hizmet zaman
    #: dilimindeki** bugün kullanılır (UTC günü değil).
    today: date | None = None


@router.post("/nlp/parse", response_model=ParseResult)
def parse(
    payload: ParseRequest,
    parser_version: str | None = Query(
        default=None,
        description="Belirli bir parser sürümü (deney/karşılaştırma için).",
    ),
) -> ParseResult:
    """Serbest metni yapılandırılmış talebe çevirir.

    `parser_version` sorgu parametresi deney içindir: aynı girdiyi baseline ve
    proposed ile çalıştırıp karşılaştırmayı mümkün kılar. Verilmezse yapılandırmadaki
    varsayılan sürüm kullanılır.
    """
    settings: Settings = get_settings()
    parser = get_parser(parser_version or settings.parser_version)
    today = payload.today or settings.today()

    return parser.parse(payload.raw_text, today=today)
