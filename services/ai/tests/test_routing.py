"""Routing portu, kuş uçuşu tahmin ve bozulma davranışı."""

from __future__ import annotations

import pytest

from app.matching.schema import Location
from app.routing.haversine import HaversineRouter, haversine_meters
from app.routing.port import RoutingProvider, RoutingUnavailableError, TravelEstimate
from app.routing.registry import FallbackRouter, get_router

ISTANBUL = Location(latitude=41.0082, longitude=28.9784)
ANKARA = Location(latitude=39.9334, longitude=32.8597)


def test_haversine_distance_matches_known_geography() -> None:
    """İstanbul-Ankara kuş uçuşu ~350 km; %2 tolerans."""
    meters = haversine_meters(ISTANBUL, ANKARA)

    assert 343_000 <= meters <= 357_000


def test_distance_to_self_is_zero() -> None:
    assert haversine_meters(ISTANBUL, ISTANBUL) == 0


def test_estimate_applies_detour_factor_and_speed_model() -> None:
    router = HaversineRouter()
    straight = haversine_meters(ISTANBUL, ANKARA)

    estimate = router.estimate(ISTANBUL, ANKARA)

    assert estimate.distance_meters > straight
    assert estimate.duration_seconds > 0
    assert estimate.provider == "haversine"


def test_estimate_from_distance_is_consistent_with_estimate() -> None:
    """Koordinat bilinmediğinde mesafeden yapılan tahmin aynı modeli kullanır."""
    router = HaversineRouter()
    straight = haversine_meters(ISTANBUL, ANKARA)

    assert router.estimate(ISTANBUL, ANKARA) == router.estimate_from_distance(straight)


def test_haversine_router_satisfies_the_port() -> None:
    assert isinstance(HaversineRouter(), RoutingProvider)


def test_invalid_router_configuration_is_rejected() -> None:
    with pytest.raises(ValueError, match="sapma katsayısı"):
        HaversineRouter(detour_factor=0.5)
    with pytest.raises(ValueError, match="ortalama hız"):
        HaversineRouter(average_speed_kmh=0.0)


def test_unknown_router_name_is_rejected() -> None:
    """Sessizce kuş uçuşuna düşmek, yapılandırma hatasını gizlerdi."""
    with pytest.raises(KeyError, match="bilinmeyen rota sağlayıcısı"):
        get_router("google-maps-not-configured")


def test_negative_estimates_are_rejected() -> None:
    with pytest.raises(ValueError, match="negatif"):
        TravelEstimate(distance_meters=-1, duration_seconds=10, provider="test")


class _FailingRouter:
    """Her çağrıda düşen sağlayıcı; kaç kez çağrıldığını sayar."""

    def __init__(self) -> None:
        self.calls = 0

    @property
    def name(self) -> str:
        return "failing"

    def estimate(self, origin: Location, destination: Location) -> TravelEstimate:
        self.calls += 1
        raise RoutingUnavailableError("erişilemiyor")

    def estimate_from_distance(self, distance_meters: int) -> TravelEstimate:
        self.calls += 1
        raise RoutingUnavailableError("erişilemiyor")


def test_fallback_router_degrades_to_haversine() -> None:
    primary = _FailingRouter()
    router = FallbackRouter(primary=primary, fallback=HaversineRouter())

    estimate = router.estimate(ISTANBUL, ANKARA)

    assert router.degraded is True
    assert router.name == "haversine"
    assert estimate.provider == "haversine"


def test_failed_primary_is_not_retried_for_every_candidate() -> None:
    """Her aday için yeniden zaman aşımı beklemek, gecikmeyi aday sayısıyla çarpardı."""
    primary = _FailingRouter()
    router = FallbackRouter(primary=primary, fallback=HaversineRouter())

    for _ in range(10):
        router.estimate(ISTANBUL, ANKARA)

    assert primary.calls == 1


def test_healthy_primary_is_used_and_not_marked_degraded() -> None:
    router = FallbackRouter(primary=HaversineRouter(), fallback=HaversineRouter())

    router.estimate(ISTANBUL, ANKARA)

    assert router.degraded is False
    assert router.name == "haversine"
