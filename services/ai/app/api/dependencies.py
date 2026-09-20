"""Ortak endpoint bağımlılıkları."""

from __future__ import annotations

import hmac
from typing import Annotated

from fastapi import Depends, Header, HTTPException, status

from app.config import Settings, get_settings


def require_service_key(
    x_service_key: Annotated[str | None, Header()] = None,
) -> None:
    """Servisler arası paylaşılan sır kontrolü (Faz 6 review bulgusu L1).

    Sır tanımlı değilse (yerel geliştirme) kontrol atlanır; production'da tanımlı
    olmak zorunludur (config doğrulaması). Karşılaştırma sabit zamanlıdır: farklı
    yanıt süreleri anahtarı karakter karakter tahmin etmeye izin verirdi.

    Bu, ağ politikasının yerine geçmez — ikinci katmandır. Tek katmanlı bir savunma,
    ağ yapılandırmasındaki bir hatayı doğrudan yetkisiz erişime çevirir.
    """
    settings: Settings = get_settings()
    expected = settings.service_api_key

    if expected is None:
        return

    if x_service_key is None or not hmac.compare_digest(x_service_key, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="service key invalid",
        )


ServiceKeyGuard = Depends(require_service_key)
