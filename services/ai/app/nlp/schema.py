"""Yapılandırılmış hizmet talebi şeması (ADR-0007 §2).

NLP çıktısı **bu şemadan geçmeden** hiçbir iş kuralına veya SQL'e girdi olamaz.
Şema, modelin ne üretebileceğinin sınırıdır: serbest metin alan yoktur, her alan
ya kapalı bir kümeden gelir ya da sayısal/tarihsel bir aralıkla sınırlıdır.

Gerekçe: doğrulanmamış bir model çıktısını iş kuralına vermek, kullanıcının yazdığı
metnin sisteme komut olarak sızması demektir (prompt injection). Şema bu yüzden
güvenlik sınırıdır, yalnızca tip kolaylığı değil.
"""

from __future__ import annotations

from datetime import date as date_type
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

# Katalog slug'ları ile birebir aynı (services.slug). Model serbest bir hizmet adı
# uyduramaz: uydurursa şema doğrulaması reddeder.
SERVICE_SLUGS = (
    "standart-temizlik",
    "detayli-temizlik",
    "tasinma-temizligi",
    "yasli-bakimi",
    "cocuk-bakimi",
    "hasta-refakati",
    "gunluk-yemek",
    "haftalik-mealprep",
)

ServiceType = Literal[
    "standart-temizlik",
    "detayli-temizlik",
    "tasinma-temizligi",
    "yasli-bakimi",
    "cocuk-bakimi",
    "hasta-refakati",
    "gunluk-yemek",
    "haftalik-mealprep",
]

# Yetkinlik slug'ları (skills.slug) ile aynı küme.
REQUIREMENT_SLUGS = (
    "pet-friendly",
    "derin-temizlik",
    "ilk-yardim",
    "yasli-bakim-deneyimi",
    "cocuk-gelisimi",
    "utu",
    "cam-temizligi",
    "vegan-mutfak",
)

Requirement = Literal[
    "pet-friendly",
    "derin-temizlik",
    "ilk-yardim",
    "yasli-bakim-deneyimi",
    "cocuk-gelisimi",
    "utu",
    "cam-temizligi",
    "vegan-mutfak",
]


class DayPart(StrEnum):
    """Günün kaba bölümü. Saat verilmediğinde kullanılır."""

    MORNING = "MORNING"
    NOON = "NOON"
    AFTERNOON = "AFTERNOON"
    EVENING = "EVENING"


# Gün bölümlerinin saat karşılıkları. Tek yerde tutulur: parser ve core aynı
# aralığı kullanmak zorunda, aksi halde "sabah" iki serviste farklı anlama gelir.
DAY_PART_HOURS: dict[DayPart, tuple[int, int]] = {
    DayPart.MORNING: (8, 12),
    DayPart.NOON: (11, 14),
    DayPart.AFTERNOON: (13, 18),
    DayPart.EVENING: (17, 21),
}


class TimeWindow(BaseModel):
    """Hizmetin başlayabileceği saat aralığı (yerel saat, 0-24)."""

    model_config = ConfigDict(frozen=True)

    start_hour: int = Field(ge=0, le=23)
    end_hour: int = Field(ge=1, le=24)
    day_part: DayPart | None = None

    @model_validator(mode="after")
    def _end_after_start(self) -> TimeWindow:
        if self.end_hour <= self.start_hour:
            raise ValueError("end_hour, start_hour'dan büyük olmalı")
        return self

    @classmethod
    def from_day_part(cls, day_part: DayPart) -> TimeWindow:
        start, end = DAY_PART_HOURS[day_part]
        return cls(start_hour=start, end_hour=end, day_part=day_part)


class StructuredRequest(BaseModel):
    """Doğrulanmış talep. Buradan sonrası deterministik motorun işidir (ADR-0007)."""

    model_config = ConfigDict(frozen=True)

    service_type: ServiceType
    # Süre üst sınırı bir gün: "300 saat temizlik" gibi bir çıktı iş kuralına girmemeli.
    duration_minutes: int = Field(ge=30, le=1440)
    service_date: date_type | None = None
    time_window: TimeWindow | None = None
    # Serbest metin **değil**: yalnızca bilinen yetkinlik slug'ları.
    requirements: tuple[Requirement, ...] = ()

    # `preferences` alanı **bilinçli olarak yoktur** (Faz 6 review bulgusu M2).
    #
    # Önceki taslakta `tuple[str, ...]` olarak duruyordu: hiçbir parser doldurmuyordu
    # ama şemanın "serbest metin alanı yok" güvencesini kâğıt üzerinde bırakıyordu.
    # Prompt injection savunması tam olarak bu güvenceye dayanıyor — doldurulmaya
    # başlandığı gün, doğrulanmamış kullanıcı metni şemadan geçip core'a ulaşırdı.
    # Soft constraint'ler Faz 7'de **kapalı bir slug kümesiyle** geri gelecek.

    @model_validator(mode="after")
    def _no_duplicate_requirements(self) -> StructuredRequest:
        if len(set(self.requirements)) != len(self.requirements):
            raise ValueError("requirements tekrar içeremez")
        return self


class FieldConfidence(BaseModel):
    """Alan bazlı güven skoru — kalibrasyon ölçümü için (research-metrics §2.1)."""

    model_config = ConfigDict(frozen=True)

    service_type: float = Field(ge=0.0, le=1.0)
    duration_minutes: float = Field(ge=0.0, le=1.0)
    service_date: float = Field(ge=0.0, le=1.0)
    time_window: float = Field(ge=0.0, le=1.0)
    requirements: float = Field(ge=0.0, le=1.0)


class ParseStatus(StrEnum):
    """Ayrıştırma sonucu.

    `NEEDS_CLARIFICATION` bilinçli bir üçüncü durumdur: tahmin etmek yerine sormak,
    yanlış hizmetle rezervasyon oluşturmaktan iyidir (ADR-0007 §2).
    """

    PARSED = "PARSED"
    NEEDS_CLARIFICATION = "NEEDS_CLARIFICATION"
    REJECTED = "REJECTED"


class ClarificationQuestion(BaseModel):
    """Eksik/belirsiz alan için kullanıcıya sorulacak soru."""

    model_config = ConfigDict(frozen=True)

    field: Literal["service_type", "duration_minutes", "service_date", "time_window"]
    question: str
    # İstemci bunları seçenek olarak gösterir; serbest metne zorlamaz.
    options: tuple[str, ...] = ()


class ParseResult(BaseModel):
    """NLP yanıtı.

    `parser_version` ve `confidence` **zorunludur** (ADR-0012 §1): sürümsüz bir çıktı
    geriye dönük deney yapılmasını imkânsız kılar.
    """

    model_config = ConfigDict(frozen=True)

    status: ParseStatus
    parser_version: str = Field(min_length=1, max_length=64)
    confidence: float = Field(ge=0.0, le=1.0)
    request: StructuredRequest | None = None
    field_confidence: FieldConfidence | None = None
    clarifications: tuple[ClarificationQuestion, ...] = ()
    # Ayrıştırma sırasında fark edilen ama karara girmeyen gözlemler (ör. girdi kırpıldı).
    warnings: tuple[str, ...] = ()

    @model_validator(mode="after")
    def _payload_matches_status(self) -> ParseResult:
        if self.status is ParseStatus.PARSED and self.request is None:
            raise ValueError("PARSED sonuç bir request taşımak zorunda")
        if self.status is ParseStatus.NEEDS_CLARIFICATION and not self.clarifications:
            raise ValueError("NEEDS_CLARIFICATION en az bir soru taşımak zorunda")
        if self.status is ParseStatus.REJECTED and self.request is not None:
            raise ValueError("REJECTED sonuç request taşıyamaz")
        return self
