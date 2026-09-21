"""Routing portu (ADR-0002, CLAUDE.md §2).

Yol ağı bilgisi Emek'in Ar-Ge motoru değildir, **altyapıdır**. Bu yüzden mesafe ve
seyahat süresi bir portun arkasındadır: optimizasyon motoru hangi sağlayıcının
konuştuğunu bilmez. Google Route Optimization/Distance Matrix gibi bir sağlayıcı
aynı porta takılır ve optimizasyon kodu değişmez.

Port bilinçli olarak **dar**dır: iki nokta arası tahmin ve mesafeden süre tahmini.
Sağlayıcıya "şu atamayı optimize et" dedirtmek, Emek'in optimizasyon mantığını dış
servise taşımak olurdu.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from app.matching.schema import Location


class RoutingUnavailableError(RuntimeError):
    """Rota sağlayıcısına ulaşılamadı veya yanıtı kullanılamaz.

    Bir iş hatası değildir: çağıran bunu bir **sonuç** olarak alır ve elindeki
    coğrafi veriyle (kuş uçuşu mesafe) devam eder, sonucu `degraded` işaretler.
    """


@dataclass(frozen=True)
class TravelEstimate:
    """Tahmini seyahat. `provider`, tahmini hangi kaynağın ürettiğini taşır."""

    distance_meters: int
    duration_seconds: int
    provider: str

    def __post_init__(self) -> None:
        if self.distance_meters < 0 or self.duration_seconds < 0:
            raise ValueError("seyahat tahmini negatif olamaz")


@runtime_checkable
class RoutingProvider(Protocol):
    """Mesafe/süre kaynağı."""

    @property
    def name(self) -> str:
        """Kaynak etiketi; sonuçla birlikte saklanır."""
        ...

    def estimate(self, origin: Location, destination: Location) -> TravelEstimate:
        """İki nokta arası tahmin. Ulaşılamazsa `RoutingUnavailableError`."""
        ...

    def estimate_from_distance(self, distance_meters: int) -> TravelEstimate:
        """Mesafesi bilinen ama başlangıç koordinatı bilinmeyen durum için tahmin.

        Sağlayıcının hizmet bölgesi merkezi yoksa (poligon tanımlanmamışsa) yalnızca
        müşteriye olan mesafe bilinir. Gerçek yol ağı sağlayıcıları bunu kendi hız
        modelleriyle yaklaşıklar; kesin rota değildir ve öyle raporlanmaz.
        """
        ...
