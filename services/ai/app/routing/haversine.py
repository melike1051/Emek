"""Dış servis gerektirmeyen rota tahmini.

Her zaman kullanılabilir olması **tasarım gereğidir**: matching, dış bir servis
erişilemez diye durmaz (CLAUDE.md "routing unavailable → safe fallback"). Kuş uçuşu
mesafe bir alt sınırdır; şehir içi yol ağı için sapma katsayısıyla çarpılır.

Bu tahmin gerçek rota değildir ve rapor/benchmark'ta öyle etiketlenir.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from app.matching.schema import Location
from app.routing.port import TravelEstimate

#: Dünya yarıçapı (m) — WGS84 ortalama.
_EARTH_RADIUS_M = 6_371_008.8

#: Kuş uçuşu → yol mesafesi sapma katsayısı. Şehir içi ızgara düzeninde tipik olarak
#: 1.2-1.4 arasıdır; ortası alındı. Katsayı bir **varsayımdır** ve gerçek rota
#: sağlayıcısı bağlandığında ölçülerek güncellenir.
_DETOUR_FACTOR = 1.3

#: Ortalama şehir içi hız (km/sa). Trafik modeli yoktur; sabit hız bilinçli bir
#: basitleştirmedir ve gerçek ETA iddiası taşımaz.
_AVERAGE_SPEED_KMH = 30.0


def haversine_meters(origin: Location, destination: Location) -> int:
    """İki koordinat arası büyük çember mesafesi (metre)."""
    lat1 = math.radians(origin.latitude)
    lat2 = math.radians(destination.latitude)
    delta_lat = lat2 - lat1
    delta_lon = math.radians(destination.longitude - origin.longitude)

    a = (
        math.sin(delta_lat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    )
    return round(_EARTH_RADIUS_M * 2 * math.asin(math.sqrt(a)))


@dataclass(frozen=True)
class HaversineRouter:
    """Kuş uçuşu mesafe + sabit hız modeli."""

    detour_factor: float = _DETOUR_FACTOR
    average_speed_kmh: float = _AVERAGE_SPEED_KMH

    def __post_init__(self) -> None:
        if self.detour_factor < 1.0:
            raise ValueError("sapma katsayısı 1.0'dan küçük olamaz")
        if self.average_speed_kmh <= 0.0:
            raise ValueError("ortalama hız pozitif olmalı")

    @property
    def name(self) -> str:
        return "haversine"

    def estimate(self, origin: Location, destination: Location) -> TravelEstimate:
        straight = haversine_meters(origin, destination)
        return self.estimate_from_distance(straight)

    def estimate_from_distance(self, distance_meters: int) -> TravelEstimate:
        road_meters = round(distance_meters * self.detour_factor)
        seconds = round(road_meters / (self.average_speed_kmh * 1000 / 3600))
        return TravelEstimate(
            distance_meters=road_meters,
            duration_seconds=seconds,
            provider=self.name,
        )
