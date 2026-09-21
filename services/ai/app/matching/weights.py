"""Sürümlü skor ağırlıkları (ADR-0012 §2).

Ağırlıklar koda **gömülmez**: burada sürüm adıyla kayıtlı config nesneleridir.
Bir ağırlığı değiştirmek yeni bir sürüm üretmek demektir; eski sürüm silinmez ki
geçmiş kararlar hangi ağırlıkla verildiyse o ağırlıkla yeniden üretilebilsin.

Blueprint'teki örnek ağırlıklar (0.25/0.20/0.15/0.15/0.10/0.15) **başlangıç
değeridir, kanıtlanmış gerçek değil** (ADR-0007 §7). Ayarlanmaları için önce
kabul/tamamlanma verisi gerekir; o veri Faz 15-16'dan önce yoktur.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.matching.schema import ScoreComponents

#: Toplamın 1.0'dan sapabileceği tolerans (kayan nokta gürültüsü).
_SUM_TOLERANCE = 1e-9


@dataclass(frozen=True)
class WeightSet:
    """Bir skor ağırlığı sürümü.

    Toplam 1.0 olmak zorundadır: aksi hâlde `overall_score` [0, 1] aralığından
    çıkar, sürümler arası karşılaştırma anlamını yitirir ve saklanan skor
    kolonundaki CHECK ihlal edilir.
    """

    version: str
    skill: float
    availability: float
    quality: float
    distance: float
    rating: float
    preference: float

    def __post_init__(self) -> None:
        values = (
            self.skill,
            self.availability,
            self.quality,
            self.distance,
            self.rating,
            self.preference,
        )
        if any(value < 0.0 for value in values):
            raise ValueError(f"{self.version}: negatif ağırlık olamaz")
        total = sum(values)
        if abs(total - 1.0) > _SUM_TOLERANCE:
            raise ValueError(f"{self.version}: ağırlık toplamı 1.0 olmalı (şu an {total})")

    def combine(self, components: ScoreComponents) -> float:
        """Bileşenleri tek skora indirger.

        4 haneye yuvarlanır: kayan nokta gürültüsü iki eşit adayı farklı sıralardı
        ve determinizm testi (T-17) makineye göre değişirdi. Yuvarlamadan doğan
        beraberlikler sıralama katmanında **açık** bir kuralla çözülür.
        """
        total = (
            self.skill * components.skill_score
            + self.availability * components.availability_score
            + self.quality * components.quality_score
            + self.distance * components.distance_score
            + self.rating * components.rating_score
            + self.preference * components.preference_score
        )
        return round(min(1.0, max(0.0, total)), 4)


#: Başlangıç ağırlıkları (blueprint §13 örneği).
WEIGHTS_V1 = WeightSet(
    version="weights-v1",
    skill=0.25,
    availability=0.20,
    quality=0.15,
    distance=0.15,
    rating=0.10,
    preference=0.15,
)

#: Baseline karşılaştırması için: yalnızca mesafe (ADR-0012 §3 "basit filtre + mesafe
#: sıralaması"). Bilinçli olarak zayıftır ve **iyileştirilmez** — karşılaştırmanın
#: ölçüsü onun sabitliğine dayanır.
WEIGHTS_DISTANCE_ONLY = WeightSet(
    version="weights-distance-v0",
    skill=0.0,
    availability=0.0,
    quality=0.0,
    distance=1.0,
    rating=0.0,
    preference=0.0,
)

_REGISTRY: dict[str, WeightSet] = {
    WEIGHTS_V1.version: WEIGHTS_V1,
    WEIGHTS_DISTANCE_ONLY.version: WEIGHTS_DISTANCE_ONLY,
}


def get_weights(version: str) -> WeightSet:
    """Sürüme karşılık gelen ağırlık kümesi.

    Bilinmeyen sürümde hata verir; sessizce varsayılana düşmek, kararın yanlış
    sürüme atfedilmesine yol açardı (ADR-0012 §1).
    """
    try:
        return _REGISTRY[version]
    except KeyError as error:
        known = ", ".join(sorted(_REGISTRY))
        raise KeyError(f"bilinmeyen ağırlık sürümü: {version} (kayıtlı: {known})") from error


def available_versions() -> tuple[str, ...]:
    return tuple(sorted(_REGISTRY))
