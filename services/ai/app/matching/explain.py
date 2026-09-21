"""Açıklanabilirlik üretimi (ADR-0007 §6).

İki kural:

1. Açıklama **saklanan skor bileşenlerinden ve kısıt sonuçlarından** üretilir.
   Modele "neden seçtin" diye sorulmaz: sorulsaydı açıklama kararın gerekçesi değil,
   kararın üzerine sonradan yazılmış bir anlatı olurdu.
2. Açıklama **kapalı kod kümesidir**, serbest metin değil. İstemci metni kendi
   diliyle üretir; böylece hem çeviri mümkün olur hem de açıklama kanalından
   beklenmedik veri sızma yüzeyi kalmaz.

Sızıntı sınırı (T-19): `value` yalnızca bu karara ait türetilmiş bir sayıdır.
Başka bir müşterinin rezervasyonu, sağlayıcının adresi, takvimi veya iletişim
bilgisi açıklamaya **hiçbir biçimde** girmez.
"""

from __future__ import annotations

from app.matching.schema import (
    BookingDemand,
    CandidateFeatures,
    ExplanationCode,
    ExplanationReason,
    ScoreComponents,
    SkillLevel,
)

#: "Yakın" sayılan üst sınır (metre). Açıklama için kaba bir eşiktir; skor zaten
#: sürekli bir fonksiyondur.
_NEARBY_METERS = 5_000

#: Açıklamada bildirilen mesafenin kovalanma adımı (metre).
#:
#: Müşterinin birden fazla adresi olabilir ve eşleştirmeyi tekrar çalıştırabilir.
#: 100 m çözünürlükte üç okuma, sağlayıcının referans noktasını dar bir daireye
#: indirger (üçleme). 1 km kova bunu kullanışsız hâle getirir; "yakın mı" sorusuna
#: cevap vermek için de bu çözünürlük yeterlidir.
_DISTANCE_BUCKET_METERS = 1_000

#: Puanın "yüksek" sayılması için gereken en az değerlendirme sayısı ve ortalama.
#: Az sayıda değerlendirmeyle "yüksek puanlı" demek, kullanıcıyı yanıltırdı.
_MIN_RATINGS_FOR_CLAIM = 5
_HIGH_RATING = 4.5

#: "Deneyimli" eşiği — kalite vekil ölçütünün doygunluk noktasıyla aynı.
_EXPERIENCED_BOOKINGS = 20

#: Kayan nokta karşılaştırmasında "tam kapsama" toleransı.
_FULL_COVERAGE = 0.999


def explain(
    demand: BookingDemand,
    candidate: CandidateFeatures,
    components: ScoreComponents,
) -> tuple[ExplanationReason, ...]:
    """Adayın gerekçelerini üretir.

    Sıra sabittir (yetkinlik → tercih → müsaitlik → mesafe → puan → deneyim):
    determinizm testi açıklamayı da kapsar, çünkü açıklama da karar kaydının
    parçasıdır ve `booking_match_results.explanation` kolonuna yazılır.
    """
    reasons: list[ExplanationReason] = []

    if demand.required_skills:
        reasons.append(
            ExplanationReason(
                code=ExplanationCode.ALL_REQUIRED_SKILLS_VERIFIED,
                value=float(len(demand.required_skills)),
            )
        )
        expert_count = sum(
            1
            for skill in demand.required_skills
            if candidate.skill_levels.get(skill) is SkillLevel.EXPERT
        )
        if expert_count > 0:
            reasons.append(
                ExplanationReason(
                    code=ExplanationCode.EXPERT_LEVEL_SKILLS,
                    value=float(expert_count),
                )
            )

    if demand.preferred_skills:
        verified = set(candidate.verified_skills)
        matched = sum(1 for skill in demand.preferred_skills if skill in verified)
        if matched == len(demand.preferred_skills):
            reasons.append(
                ExplanationReason(
                    code=ExplanationCode.PREFERRED_SKILLS_MATCHED,
                    value=float(matched),
                )
            )
        elif matched > 0:
            reasons.append(
                ExplanationReason(
                    code=ExplanationCode.PREFERRED_SKILLS_PARTIAL,
                    value=float(matched),
                )
            )

    if components.availability_score >= _FULL_COVERAGE:
        reasons.append(ExplanationReason(code=ExplanationCode.FULL_WINDOW_AVAILABLE))
    elif components.availability_score > 0.0:
        # Değer **taşınmaz**: `availability_score`, sağlayıcının talep penceresinin ne
        # kadarında boş olduğudur — yani takvim doluluğu. Müşteriye ham hâlde vermek,
        # eşleştiği sağlayıcının o günkü meşguliyetini sayısallaştırıp sunmak olurdu.
        # "Kısmen müsait" bilgisi karar için yeterli, doluluk oranı değil.
        reasons.append(ExplanationReason(code=ExplanationCode.PARTIAL_WINDOW_AVAILABLE))

    if candidate.distance_meters <= _NEARBY_METERS:
        # Mesafe 1 km kovalarına yuvarlanır (yukarı): metre — hatta 100 m —
        # hassasiyetinde bir değer, tekrarlanan taleplerle sağlayıcının referans
        # noktasını üçlemeye izin verirdi.
        bucket_km = max(
            1,
            -(-candidate.distance_meters // _DISTANCE_BUCKET_METERS),
        )
        reasons.append(ExplanationReason(code=ExplanationCode.NEARBY, value=float(bucket_km)))

    if candidate.within_service_area:
        reasons.append(ExplanationReason(code=ExplanationCode.WITHIN_SERVICE_AREA))

    if candidate.rating_count >= _MIN_RATINGS_FOR_CLAIM:
        if candidate.rating_avg is not None and candidate.rating_avg >= _HIGH_RATING:
            reasons.append(
                ExplanationReason(
                    code=ExplanationCode.HIGH_RATING,
                    value=round(candidate.rating_avg, 2),
                )
            )
    else:
        reasons.append(
            ExplanationReason(
                code=ExplanationCode.LIMITED_RATING_HISTORY,
                value=float(candidate.rating_count),
            )
        )

    if candidate.completed_bookings >= _EXPERIENCED_BOOKINGS:
        reasons.append(ExplanationReason(code=ExplanationCode.EXPERIENCED))

    return tuple(reasons)
