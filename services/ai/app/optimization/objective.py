"""Sürümlü amaç fonksiyonu katsayıları (ADR-0012 §2).

Ağırlıklar gibi amaç fonksiyonu da koda gömülmez: katsayılar sürüm adıyla kayıtlı
config nesneleridir ve her optimizasyon sonucu hangi sürümle üretildiğini taşır
(`objective_version`). Bir katsayıyı değiştirmek yeni sürüm üretmek demektir.

Amaç fonksiyonunun biçimi:

    maksimize  Σ atama·(ATAMA_ÖDÜLÜ + skor·ÖLÇEK − sıra − yol_cezası·ev_yolu_dk)
             − Σ ardışık_çift·yol_cezası·aradaki_yol_dk

Üç katsayının ilişkisi kararın önceliğini belirler ve bilinçlidir:

- `assignment_bonus` en büyüktür: bir müşteriyi sağlayıcısız bırakmak, daha iyi
  skorlu bir atamadan her zaman kötüdür.
- `score_scale` ikinci sıradadır: atama sayısı eşitse çok kriterli skor karar verir.
- `travel_penalty_per_minute` bir **düzeltme terimidir**, kararın kendisi değil.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ObjectiveConfig:
    """Amaç fonksiyonu katsayıları."""

    version: str
    #: Skorun tam sayıya ölçeklenmesi. CP-SAT tam sayı çalışır.
    score_scale: int
    #: Atama başına sabit ödül.
    assignment_bonus: int
    #: Seyahat dakikası başına ceza.
    travel_penalty_per_minute: int
    #: Eşit amaç değerinde sıralamada önde olanı seçtiren küçük terim.
    rank_tiebreak: int

    def __post_init__(self) -> None:
        if self.score_scale <= 0:
            raise ValueError(f"{self.version}: score_scale pozitif olmalı")
        if self.assignment_bonus <= self.score_scale:
            # Aksi hâlde çözücü, bir atamayı feda edip başka bir atamanın skorunu
            # yükseltmeyi tercih edebilir ve bir müşteri sağlayıcısız kalırdı.
            raise ValueError(f"{self.version}: assignment_bonus, score_scale'den büyük olmalı")
        if self.travel_penalty_per_minute < 0 or self.rank_tiebreak < 0:
            raise ValueError(f"{self.version}: negatif ceza/eşitlik terimi olamaz")


#: Başlangıç sürümü. Yol cezası kasıtlı olarak küçüktür: bir dakikalık yol, skorda
#: 0.0005'lik bir farka denktir. Bu bir **varsayımdır** ve Faz 7 benchmark'ında
#: ölçülmüştür (bkz. EXP-002 "seyahat maliyeti" bulgusu).
OBJECTIVE_V1 = ObjectiveConfig(
    version="objective-v1",
    score_scale=10_000,
    assignment_bonus=100 * 10_000,
    travel_penalty_per_minute=5,
    rank_tiebreak=1,
)

#: Duyarlılık analizi sürümü: yol cezası 12 kat ağır (bir dakikalık yol ≈ 0.006 skor).
#: EXP-002'de `objective-v1`'in seyahat maliyetini pratikte dikkate almadığı ölçüldü;
#: bu sürüm o bulgunun **ölçülmüş** karşılığıdır, varsayılan değildir.
OBJECTIVE_V2_TRAVEL = ObjectiveConfig(
    version="objective-v2-travel",
    score_scale=10_000,
    assignment_bonus=100 * 10_000,
    travel_penalty_per_minute=60,
    rank_tiebreak=1,
)

_REGISTRY: dict[str, ObjectiveConfig] = {
    OBJECTIVE_V1.version: OBJECTIVE_V1,
    OBJECTIVE_V2_TRAVEL.version: OBJECTIVE_V2_TRAVEL,
}


def get_objective(version: str) -> ObjectiveConfig:
    """Sürüme karşılık gelen amaç fonksiyonu. Bilinmeyen sürümde hata verir."""
    try:
        return _REGISTRY[version]
    except KeyError as error:
        known = ", ".join(sorted(_REGISTRY))
        raise KeyError(f"bilinmeyen amaç sürümü: {version} (kayıtlı: {known})") from error


def available_versions() -> tuple[str, ...]:
    return tuple(sorted(_REGISTRY))
