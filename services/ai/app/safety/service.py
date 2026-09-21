"""Anomali değerlendirmesi + rota tahmini orkestrasyonu."""

from __future__ import annotations

from app.routing.port import RoutingProvider, RoutingUnavailableError
from app.safety import model
from app.safety.schema import AnomalyRequest, AnomalyResponse, RouteEstimateOut


def estimate_route(request: AnomalyRequest, router: RoutingProvider) -> RouteEstimateOut | None:
    """Faz 7 routing portu üzerinden son konum → hizmet noktası tahmini.

    İkinci bir rota alt sistemi **yoktur**: matching'in kullandığı port aynen
    kullanılır. Güvenlikte bir fark var: sağlayıcı erişilemezse kuş uçuşuna
    **sessizce düşülmez** — rota ``available=False`` döner ve core bu sinyali
    "eksik" işaretler. Yapılandırılmış sağlayıcının kendisi kuş uçuşu ise sonuç
    ``provider="haversine"`` etiketiyle döner ve gerçek rota iddiası taşımaz.
    """
    if request.route is None:
        return None
    try:
        estimate = router.estimate(request.route.origin, request.route.destination)
    except RoutingUnavailableError:
        return RouteEstimateOut(available=False)
    return RouteEstimateOut(
        available=True,
        provider=estimate.provider,
        eta_seconds=estimate.duration_seconds,
        distance_meters=estimate.distance_meters,
    )


def assess(request: AnomalyRequest, router: RoutingProvider, model_version: str) -> AnomalyResponse:
    route = estimate_route(request, router)
    eta = route.eta_seconds if route is not None and route.available else None
    result = model.assess(request, eta, model_version)
    return AnomalyResponse(
        model_version=model_version,
        anomaly_score=result.score,
        quality=result.quality,
        contributions=result.contributions,
        unavailable_features=result.unavailable,
        route=route,
    )
