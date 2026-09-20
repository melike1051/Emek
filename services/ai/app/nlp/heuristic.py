"""Önerilen ayrıştırıcı (proposed) — sürüm `heuristic-v1`.

Baseline'dan farkı üç yerde:

1. **Türkçe'ye duyarlı normalizasyon** (`normalize.py`): `I/İ` kuralı, aksan katlama,
   sondan eklemeye toleranslı terim eşleşmesi. "TEMİZLİĞE ihtiyacım var" baseline'da
   kaçar, burada yakalanır.
2. **Kanıt tabanlı skorlama:** hizmet türü tek bir anahtar kelimeyle değil, ağırlıklı
   kanıt toplamıyla seçilir; en iyi ile ikinci arasındaki fark güvene yansır. Baseline'ın
   sabit 0.5'i kalibrasyon ölçümünde (ECE) zayıf kalır.
3. **Zaman ve gereksinim çıkarımı** (`temporal.py` + yetkinlik sözlüğü): süre, tarih,
   saat aralığı ve yetkinlikler metinden çıkarılır; varsayılana düşülen her alan
   kendi güven skorunda bunu gösterir.

Model (LLM) tabanlı bir sürüm `llm-v1` olarak aynı porta takılacak (R-44); bu sürüm
onun karşılaştırma tabanı ve sağlayıcı erişilemediğinde çalışan yoldur.
"""

from __future__ import annotations

from datetime import date

from app.nlp.normalize import contains_term, fold
from app.nlp.sanitize import sanitize
from app.nlp.schema import (
    ClarificationQuestion,
    FieldConfidence,
    ParseResult,
    ParseStatus,
    Requirement,
    ServiceType,
    StructuredRequest,
)
from app.nlp.temporal import resolve_date, resolve_duration, resolve_time_window

#: Hizmet kanıtları: terim → ağırlık. Ağırlıklar ayırt ediciliği yansıtır —
#: "taşınma" tek başına belirleyicidir, "ev" neredeyse hiçbir şey söylemez.
#: Türkçe ünsüz yumuşaması (k → ğ) kök biçimini değiştirir: "bebek" → "bebeğime",
#: "çocuk" → "çocuğumun", "temizlik" → "temizliğe". Ek çözümleyicisi ekleri tanır ama
#: kökteki bu değişimi tanıyamaz, bu yüzden **her iki kök biçimi de** listelenir.
_SERVICE_EVIDENCE: dict[ServiceType, dict[str, float]] = {
    "standart-temizlik": {
        "temizlik": 0.6,
        "temizlig": 0.6,
        "temizle": 0.5,
        "ev temizligi": 0.9,
        "supur": 0.3,
    },
    "detayli-temizlik": {"detayli": 0.8, "derin": 0.8, "kapsamli": 0.6, "bahar": 0.5},
    "tasinma-temizligi": {"tasinma": 0.95, "tasindi": 0.8, "nakliye": 0.5, "bos ev": 0.6},
    "yasli-bakimi": {"yasli": 0.9, "nine": 0.6, "dede": 0.6, "anneanne": 0.6, "babaanne": 0.6},
    "cocuk-bakimi": {
        "cocuk": 0.85,
        "cocug": 0.85,
        "bebek": 0.8,
        "bebeg": 0.8,
        "kres": 0.5,
        "oglum": 0.6,
        "oglu": 0.6,
        "kizim": 0.6,
        "bakici": 0.4,
    },
    "hasta-refakati": {"hasta": 0.85, "refakat": 0.9, "ameliyat": 0.7, "hastane": 0.6},
    "gunluk-yemek": {"yemek": 0.7, "mutfak": 0.5, "pisir": 0.6, "asci": 0.6},
    "haftalik-mealprep": {"haftalik yemek": 0.95, "meal prep": 0.9, "haftalik": 0.4},
}

#: Kökle başlayan ama **başka kelime** olan biçimler.
#:
#: Ek listesi "camiye"yi geçerli bir çekim olarak çözer (cam + i + ye) — oysa "cami"
#: ayrı bir kelimedir ve müşterinin cami cümlesi "cam temizliği" yetkinliğine
#: dönüşmemelidir. Bu çakışmalar dil bilgisiyle çözülemez, açıkça listelenir.
_TERM_EXCLUSIONS: dict[str, tuple[str, ...]] = {
    "cam": ("cami", "camas", "camur"),
    "hasta": ("hastalik",),
    "derin": ("derinlik",),
}

#: Yetkinlik kanıtları (skills.slug ile aynı küme).
_REQUIREMENT_EVIDENCE: dict[Requirement, tuple[str, ...]] = {
    "pet-friendly": ("kedi", "kopek", "kopeg", "evcil", "hayvan"),
    "derin-temizlik": ("derin temizlik", "detayli temizlik"),
    "ilk-yardim": ("ilk yardim", "ilkyardim"),
    "yasli-bakim-deneyimi": ("yasli bakim", "bakim deneyimi"),
    "cocuk-gelisimi": ("cocuk gelisimi", "pedagog"),
    "utu": ("utu", "utule"),
    "cam-temizligi": ("cam", "camlar", "pencere"),
    "vegan-mutfak": ("vegan", "vejetaryen"),
}

#: Hizmet türü başına varsayılan süre (metinde süre yoksa).
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

#: Bu eşiğin altındaki toplam güvende tahmin edilmez, sorulur (ADR-0007 §2).
CLARIFICATION_THRESHOLD = 0.45

_SERVICE_OPTIONS = (
    "Ev temizliği",
    "Detaylı temizlik",
    "Taşınma temizliği",
    "Yaşlı bakımı",
    "Çocuk bakımı",
    "Hasta refakati",
    "Yemek hazırlığı",
)


class HeuristicParser:
    """Türkçe'ye duyarlı, kanıt tabanlı ayrıştırıcı."""

    @property
    def version(self) -> str:
        return "heuristic-v1"

    def parse(self, raw_text: str, *, today: date) -> ParseResult:
        cleaned = sanitize(raw_text)
        folded = fold(cleaned.text)

        service_type, service_confidence = self._resolve_service(folded)

        if service_type is None:
            return ParseResult(
                status=ParseStatus.NEEDS_CLARIFICATION,
                parser_version=self.version,
                confidence=0.0,
                clarifications=(
                    ClarificationQuestion(
                        field="service_type",
                        question="Hangi hizmete ihtiyacınız var?",
                        options=_SERVICE_OPTIONS,
                    ),
                ),
                warnings=cleaned.warnings,
            )

        duration_match = resolve_duration(folded)
        date_match = resolve_date(folded, today=today)
        window_match = resolve_time_window(folded)
        requirements = self._resolve_requirements(folded)

        duration = (
            duration_match.value if duration_match is not None else _DEFAULT_DURATION[service_type]
        )
        service_date = date_match.value if date_match is not None else None
        time_window = window_match.value if window_match is not None else None

        request = StructuredRequest(
            service_type=service_type,
            duration_minutes=duration,
            service_date=service_date,
            time_window=time_window,
            requirements=requirements,
        )

        field_confidence = FieldConfidence(
            service_type=service_confidence,
            # Varsayılana düşülen alan bunu güveninde gösterir: "bilmiyorum ama
            # makul bir değer koydum" ile "metinde yazıyordu" aynı şey değildir.
            duration_minutes=duration_match.confidence if duration_match else 0.3,
            service_date=date_match.confidence if date_match else 0.0,
            time_window=window_match.confidence if window_match else 0.0,
            requirements=0.8 if requirements else 0.5,
        )

        overall = self._overall_confidence(field_confidence)
        clarifications = list(self._missing_field_questions(request))

        # Düşük toplam güvende hizmet türü de teyit ettirilir: metin belirsizse
        # "muhtemelen temizliktir" diye devam etmek yanlış hizmetle rezervasyon üretir.
        if overall < CLARIFICATION_THRESHOLD:
            clarifications.insert(
                0,
                ClarificationQuestion(
                    field="service_type",
                    question="Talebinizi tam anlayamadım. Hangi hizmeti istiyorsunuz?",
                    options=_SERVICE_OPTIONS,
                ),
            )

        if clarifications:
            # Zorunlu alan eksik: tahmin edilmez, sorulur. Yanlış günde rezervasyon
            # oluşturmak, bir soru sormaktan pahalıdır.
            return ParseResult(
                status=ParseStatus.NEEDS_CLARIFICATION,
                parser_version=self.version,
                confidence=overall,
                request=request,
                field_confidence=field_confidence,
                clarifications=tuple(clarifications),
                warnings=cleaned.warnings,
            )

        return ParseResult(
            status=ParseStatus.PARSED,
            parser_version=self.version,
            confidence=overall,
            request=request,
            field_confidence=field_confidence,
            warnings=cleaned.warnings,
        )

    def _resolve_service(self, folded: str) -> tuple[ServiceType | None, float]:
        """Kanıt toplamıyla hizmet türü seçer.

        Güven, kazananın gücü kadar **ikinciye olan farkına** da bağlıdır: iki hizmet
        birbirine yakın puan aldıysa metin gerçekten belirsizdir ve bunu saklamak
        yanlış kalibrasyon olurdu.
        """
        scores: dict[ServiceType, float] = {}
        for service, evidence in _SERVICE_EVIDENCE.items():
            score = 0.0
            for term, weight in evidence.items():
                if " " in term:
                    if term in folded:
                        score += weight
                elif contains_term(folded, term, excluded=_TERM_EXCLUSIONS.get(term, ())):
                    score += weight
            if score > 0:
                scores[service] = score

        if not scores:
            return None, 0.0

        ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)
        best_service, best_score = ranked[0]
        runner_up = ranked[1][1] if len(ranked) > 1 else 0.0

        strength = min(best_score, 1.0)
        margin = min((best_score - runner_up) / best_score, 1.0) if best_score > 0 else 0.0
        confidence = round(min(0.5 * strength + 0.5 * (0.4 + 0.6 * margin), 0.99), 3)

        return best_service, confidence

    def _resolve_requirements(self, folded: str) -> tuple[Requirement, ...]:
        found: list[Requirement] = []
        for requirement, terms in _REQUIREMENT_EVIDENCE.items():
            for term in terms:
                matched = (
                    term in folded
                    if " " in term
                    else contains_term(folded, term, excluded=_TERM_EXCLUSIONS.get(term, ()))
                )
                if matched:
                    found.append(requirement)
                    break
        return tuple(found)

    def _overall_confidence(self, fields: FieldConfidence) -> float:
        """Toplam güven.

        Hizmet türü baskın ağırlığı taşır: yanlış hizmet türü rezervasyonu tamamen
        geçersiz kılar, eksik saat aralığı ise yalnızca daraltılmamış bir aramadır.
        """
        weighted = (
            0.55 * fields.service_type
            + 0.15 * fields.duration_minutes
            + 0.15 * fields.service_date
            + 0.10 * fields.time_window
            + 0.05 * fields.requirements
        )
        return round(min(weighted, 0.99), 3)

    def _missing_field_questions(
        self, request: StructuredRequest
    ) -> tuple[ClarificationQuestion, ...]:
        """Rezervasyon için **zorunlu** olan ama metinde bulunmayan alanlar."""
        questions: list[ClarificationQuestion] = []

        if request.service_date is None:
            questions.append(
                ClarificationQuestion(
                    field="service_date",
                    question="Hizmeti hangi gün istiyorsunuz?",
                )
            )

        if request.time_window is None:
            questions.append(
                ClarificationQuestion(
                    field="time_window",
                    question="Günün hangi saatlerinde uygun olursunuz?",
                    options=("Sabah", "Öğle", "Öğleden sonra", "Akşam"),
                )
            )

        return tuple(questions)
