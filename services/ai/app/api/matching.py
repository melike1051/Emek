"""Matching endpoint'i.

Servis **karar üretir ama yazmaz** (ADR-0002): sonuç core'a döner, core onu kendi
doğrulamasından geçirip `booking_match_results` ve `bookings` tablolarına yazar.
Bu yüzden yanıtta rezervasyon kimliği, fiyat veya durum alanı yoktur.

Uç, NLP uçlarıyla aynı paylaşılan sır kontrolünden geçer: servis yalnızca ağ
politikasına güvenmez (ADR-0013 "deny by default").
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status

from app.api.dependencies import ServiceKeyGuard
from app.config import Settings, get_settings
from app.matching.engine import solve_request
from app.matching.schema import SolveRequest, SolveResult

router = APIRouter(tags=["matching"], dependencies=[ServiceKeyGuard])


@router.post("/matching/solve", response_model=SolveResult)
def solve(payload: SolveRequest) -> SolveResult:
    """Aday havuzunu sıralar ve (istenirse) küresel atamayı çözer.

    Tek talep de birden fazla talep de aynı yoldan geçer: ayrı bir "tek talep" kod
    yolu, iki yolun zamanla farklı davranması demek olurdu.
    """
    settings: Settings = get_settings()
    _enforce_limits(payload, settings)

    return solve_request(
        payload,
        algorithm_version=settings.matching_algorithm_version,
        weights_version=settings.matching_weights_version,
        objective_version=settings.optimization_objective_version,
        service_timezone=settings.service_timezone,
        max_distance_meters=payload.max_distance_meters or settings.matching_max_distance_meters,
        time_limit_seconds=settings.optimization_time_limit_seconds,
    )


def _enforce_limits(payload: SolveRequest, settings: Settings) -> None:
    """Yapılandırılmış üst sınırları uygular.

    Şemadaki `max_length` mutlak tavandır; buradaki kontrol **işletme sınırıdır** ve
    ortama göre daraltılabilir. Yalnızca çağıranın (core) kendi sınırlarına güvenmek,
    servisin ağ politikasına güvenmesiyle aynı hatadır (ADR-0013 "deny by default").

    Neden çözücü zaman limiti yetmiyor: model kurulumu, skorlama ve sağlayıcılar arası
    O(n²) yol matrisi çözücü **başlamadan önce** çalışır. Zaman limiti aramayı
    sınırlar, kurulumu değil (R-16).
    """
    if len(payload.demands) > settings.optimization_max_bookings:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(f"en fazla {settings.optimization_max_bookings} talep birlikte çözülebilir"),
        )

    for demand in payload.demands:
        if len(demand.candidates) > settings.optimization_max_candidates_per_booking:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=(
                    "talep başına en fazla "
                    f"{settings.optimization_max_candidates_per_booking} aday değerlendirilir"
                ),
            )
