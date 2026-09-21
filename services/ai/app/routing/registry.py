"""Rota sağlayıcısı seçimi ve bozulma davranışı."""

from __future__ import annotations

from dataclasses import dataclass

from app.matching.schema import Location
from app.routing.haversine import HaversineRouter
from app.routing.port import RoutingProvider, RoutingUnavailableError, TravelEstimate


@dataclass
class FallbackRouter:
    """Birincil sağlayıcı düşerse kuş uçuşu tahmine döner.

    Bozulma **işaretlenir**: `degraded` bayrağı okunarak sonuç "gerçek rota" gibi
    raporlanmaz. Sessiz bir fallback, ETA doğruluğu iddiasını ölçülemez kılardı.

    Birincil sağlayıcı bir kez düştüğünde bu çalıştırma boyunca tekrar denenmez:
    her aday için yeniden zaman aşımı beklemek, matching gecikmesini aday sayısıyla
    çarpardı.
    """

    primary: RoutingProvider
    fallback: RoutingProvider

    degraded: bool = False

    @property
    def name(self) -> str:
        return self.fallback.name if self.degraded else self.primary.name

    def estimate(self, origin: Location, destination: Location) -> TravelEstimate:
        if not self.degraded:
            try:
                return self.primary.estimate(origin, destination)
            except RoutingUnavailableError:
                self.degraded = True
        return self.fallback.estimate(origin, destination)

    def estimate_from_distance(self, distance_meters: int) -> TravelEstimate:
        if not self.degraded:
            try:
                return self.primary.estimate_from_distance(distance_meters)
            except RoutingUnavailableError:
                self.degraded = True
        return self.fallback.estimate_from_distance(distance_meters)


_BUILTIN: dict[str, type[HaversineRouter]] = {"haversine": HaversineRouter}


def get_router(name: str) -> RoutingProvider:
    """Ada karşılık gelen rota sağlayıcısı.

    Bilinmeyen adda hata verir: sessizce kuş uçuşuna düşmek, yapılandırma hatasını
    "ETA çalışıyor" gibi gösterirdi.
    """
    try:
        return _BUILTIN[name]()
    except KeyError as error:
        known = ", ".join(sorted(_BUILTIN))
        raise KeyError(f"bilinmeyen rota sağlayıcısı: {name} (kayıtlı: {known})") from error
