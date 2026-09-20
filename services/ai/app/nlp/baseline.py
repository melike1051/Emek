"""Baseline parser (ADR-0012 §3: her Ar-Ge ekseninde baseline zorunludur).

Bu, "naif ama makul" bir çözümdür: küçük harfe çevir, anahtar kelime ara, varsayılan
süre ata. Türkçe'ye özgü hiçbir şey bilmez — ne `I/İ` kuralını, ne sondan eklemeyi,
ne göreli tarihleri.

**Bilinçli olarak zayıf bırakılmıştır ve öyle kalmalıdır.** Baseline'ı iyileştirmek,
"proposed ne kadar iyi?" sorusunun ölçüsünü kaydırır. Karşılaştırma bu dosyanın
donmuş olmasına dayanır; iyileştirme fikirleri yeni bir sürüme gider.
"""

from __future__ import annotations

from datetime import date, timedelta

from app.nlp.sanitize import sanitize
from app.nlp.schema import (
    ClarificationQuestion,
    FieldConfidence,
    ParseResult,
    ParseStatus,
    ServiceType,
    StructuredRequest,
)

#: Anahtar kelime → hizmet. Sıra önemli: ilk eşleşen kazanır.
_KEYWORDS: tuple[tuple[str, ServiceType], ...] = (
    ("taşınma", "tasinma-temizligi"),
    ("detaylı", "detayli-temizlik"),
    ("temizlik", "standart-temizlik"),
    ("yaşlı", "yasli-bakimi"),
    ("çocuk", "cocuk-bakimi"),
    ("hasta", "hasta-refakati"),
    ("yemek", "gunluk-yemek"),
)

#: Baseline süreyi metinden çıkarmaz; hizmet başına sabit varsayılan kullanır.
_DEFAULT_DURATION: dict[ServiceType, int] = {
    "standart-temizlik": 180,
    "detayli-temizlik": 300,
    "tasinma-temizligi": 480,
    "yasli-bakimi": 240,
    "cocuk-bakimi": 240,
    "hasta-refakati": 360,
    "gunluk-yemek": 180,
    "haftalik-mealprep": 300,
}


class BaselineParser:
    """Kural/regex tabanlı referans ayrıştırıcı."""

    @property
    def version(self) -> str:
        return "baseline-v0"

    def parse(self, raw_text: str, *, today: date) -> ParseResult:
        cleaned = sanitize(raw_text)
        # Türkçe'ye duyarsız küçültme: "İSTANBUL" gibi girdilerde eşleşmeyi kaçırır.
        lowered = cleaned.text.lower()

        service_type: ServiceType | None = None
        for keyword, candidate in _KEYWORDS:
            if keyword in lowered:
                service_type = candidate
                break

        if service_type is None:
            return ParseResult(
                status=ParseStatus.NEEDS_CLARIFICATION,
                parser_version=self.version,
                confidence=0.0,
                clarifications=(
                    ClarificationQuestion(
                        field="service_type",
                        question="Hangi hizmete ihtiyacınız var?",
                    ),
                ),
                warnings=cleaned.warnings,
            )

        # Yalnızca tek bir göreli ifade bilinir.
        service_date = today + timedelta(days=1) if "yarın" in lowered else None

        request = StructuredRequest(
            service_type=service_type,
            duration_minutes=_DEFAULT_DURATION[service_type],
            service_date=service_date,
        )

        return ParseResult(
            status=ParseStatus.PARSED,
            parser_version=self.version,
            # Sabit güven skoru: baseline kendi belirsizliğini ölçemez. Kalibrasyon
            # karşılaştırmasında (ECE) bu zayıflık görünür olur.
            confidence=0.5,
            request=request,
            field_confidence=FieldConfidence(
                service_type=0.5,
                duration_minutes=0.2,
                service_date=0.5 if service_date is not None else 0.0,
                time_window=0.0,
                requirements=0.0,
            ),
            warnings=cleaned.warnings,
        )
