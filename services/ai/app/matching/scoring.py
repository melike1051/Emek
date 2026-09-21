"""Skor bileşenleri (ADR-0007 §5).

Her bileşen ayrı bir fonksiyondur ve [0, 1] aralığında bir değer üretir. Bileşenler
**ayrı ayrı saklanır**: tek bir `overall_score` saklamak, "neden bu sağlayıcı?"
sorusunu sonradan yanıtlanamaz kılardı ve ağırlık deneylerini imkânsızlaştırırdı.

Ağırlıklar burada yok: bileşen hesabı ile ağırlıklandırma ayrı katmanlardır
(`weights.py`). Ağırlığı değiştirmek bileşen kodunu değiştirmez.

Sabitler bilinçlidir ve gerekçesi yanlarında yazılıdır. Hiçbiri "deneyle bulunmuş
en iyi değer" değildir — başlangıç değerleridir ve `weights_version` ile birlikte
`algorithm_version` altında sürümlenir.
"""

from __future__ import annotations

from app.matching.constraints import feasible_intervals
from app.matching.schema import (
    BookingDemand,
    CandidateFeatures,
    Interval,
    ScoreComponents,
    SkillLevel,
)

#: Yetkinlik seviyesinin skora katkısı. Doğrulanmış ama başlangıç seviyesindeki bir
#: yetkinlik hard constraint'i geçer (vardır), fakat uzman seviyesiyle aynı değildir.
_LEVEL_WEIGHT: dict[SkillLevel, float] = {
    SkillLevel.BEGINNER: 0.50,
    SkillLevel.INTERMEDIATE: 0.75,
    SkillLevel.EXPERT: 1.00,
}

#: Talepte zorunlu yetkinlik yoksa yetkinlik derinliği hakkında **kanıt yoktur**.
#: 1.0 vermek kanıtsız sağlayıcıyı uzmanla eşitlerdi, 0.0 vermek cezalandırırdı.
_NO_REQUIRED_SKILL_NEUTRAL = 0.75

#: Puan geçmişi olmayan sağlayıcı için Bayes önseli (ortalama ve ağırlık).
#: Tek bir 5 yıldız alan yeni sağlayıcı, 200 değerlendirmeyle 4.8 tutan sağlayıcıyı
#: geçmemeli; önsel bunu "yeterli kanıt yok" diyerek engeller. `_PRIOR_WEIGHT`,
#: önselin kaç değerlendirmeye denk sayıldığıdır.
_PRIOR_RATING = 4.0
_PRIOR_WEIGHT = 5.0
_MIN_RATING = 1.0
_MAX_RATING = 5.0

#: Kalite skoru yoksa tamamlanmış hizmet sayısından türetilen vekil ölçüt.
#: Doygunluk noktası: bu sayıdan sonra ek hizmet skoru artırmaz.
_QUALITY_SATURATION_BOOKINGS = 20


def _merge(intervals: tuple[Interval, ...]) -> tuple[Interval, ...]:
    """Üst üste binen aralıkları birleştirir.

    Veritabanındaki `EXCLUDE USING GIST` zaten çakışan müsaitlik penceresine izin
    vermez; burada yine de birleştirilir, çünkü kesişim alındıktan sonra bitişik
    aralıklar oluşabilir ve çift sayılan dakika kapsamı 1.0'ın üstüne çıkarırdı.
    """
    if not intervals:
        return ()

    ordered = sorted(intervals, key=lambda interval: interval.start)
    merged: list[Interval] = [ordered[0]]

    for interval in ordered[1:]:
        last = merged[-1]
        if interval.start <= last.end:
            if interval.end > last.end:
                merged[-1] = Interval(start=last.start, end=interval.end)
        else:
            merged.append(interval)

    return tuple(merged)


def skill_score(demand: BookingDemand, candidate: CandidateFeatures) -> float:
    """Zorunlu yetkinliklerdeki **derinlik**.

    Kapsama değil derinlik ölçülür: eksik yetkinlik zaten hard constraint'te elenmiştir,
    buraya ulaşan adayın hepsi vardır. Ayırt edici olan seviyedir.
    """
    if not demand.required_skills:
        return _NO_REQUIRED_SKILL_NEUTRAL

    levels = [
        _LEVEL_WEIGHT[candidate.skill_levels[skill]]
        for skill in demand.required_skills
        if skill in candidate.skill_levels
    ]
    if not levels:
        return 0.0

    return round(sum(levels) / len(demand.required_skills), 4)


def availability_score(demand: BookingDemand, candidate: CandidateFeatures) -> float:
    """Talep penceresinin ne kadarında hizmet **başlatılabilir**.

    Süresi tam yetecek kadar müsait olan bir sağlayıcı ile tüm pencere boyunca
    müsait olan sağlayıcı aynı değildir: ikincisi optimizasyona hareket alanı verir
    ve seyahat sıralaması kurulabilir. Bu yüzden ikili (müsait/değil) değil, oranlı.
    """
    window_minutes = demand.window.minutes
    if window_minutes <= 0:
        return 0.0

    covered = sum(
        interval.overlap_minutes(demand.window)
        for interval in _merge(feasible_intervals(demand, candidate))
    )
    return round(min(1.0, covered / window_minutes), 4)


def distance_score(candidate: CandidateFeatures, *, max_distance_meters: int) -> float:
    """Mesafenin doğrusal azalışı. Üst sınırda 0, aynı noktada 1.

    Doğrusal seçildi: eşik üstü adaylar zaten elenmiş olduğu için eğri seçiminin
    ayırt edici gücü sınırlı ve doğrusal olan açıklanabilir. Eğri biçimi bir
    ağırlık deneyi konusudur (`algorithm_version` ile değişir).
    """
    if max_distance_meters <= 0:
        return 0.0
    ratio = candidate.distance_meters / max_distance_meters
    return round(min(1.0, max(0.0, 1.0 - ratio)), 4)


def rating_score(candidate: CandidateFeatures) -> float:
    """Bayes düzeltilmiş puan, [1, 5] ölçeğinden [0, 1] ölçeğine taşınır.

    Ham ortalama kullanılsaydı **tek** değerlendirme alan bir sağlayıcı listenin
    başına çıkardı; bu, sahte değerlendirmeyle sıralamayı manipüle etmenin en ucuz
    yolu olurdu (reviews migration notu: manipüle edilebilir review = manipüle
    edilebilir algoritma).
    """
    count = candidate.rating_count
    average = candidate.rating_avg if candidate.rating_avg is not None else _PRIOR_RATING

    smoothed = (average * count + _PRIOR_RATING * _PRIOR_WEIGHT) / (count + _PRIOR_WEIGHT)
    normalized = (smoothed - _MIN_RATING) / (_MAX_RATING - _MIN_RATING)
    return round(min(1.0, max(0.0, normalized)), 4)


def quality_score(candidate: CandidateFeatures) -> float:
    """Platform kalite skoru; yoksa tamamlanmış hizmet sayısından vekil ölçüt.

    Vekil ölçüt doygundur: 20. hizmetten sonra ek hizmet skoru artırmaz. Doğrusal
    ve sınırsız bir sayaç, eski sağlayıcıları kalıcı olarak öne alır ve yeni
    sağlayıcıların hiç iş almadığı bir kilitlenme üretirdi.
    """
    if candidate.quality_score is not None:
        return round(min(1.0, max(0.0, candidate.quality_score)), 4)

    return round(min(1.0, candidate.completed_bookings / _QUALITY_SATURATION_BOOKINGS), 4)


def preference_score(demand: BookingDemand, candidate: CandidateFeatures) -> float:
    """Karşılanan **tercih** oranı (soft constraint).

    Tercih belirtilmemişse karşılanmamış bir istek yoktur: 1.0. Bu, zorunlu
    yetkinliğin yokluğundaki nötr değerden (0.75) bilinçli olarak farklıdır —
    orada "kanıt yok", burada "istek yok" durumu vardır.
    """
    if not demand.preferred_skills:
        return 1.0

    verified = set(candidate.verified_skills)
    matched = sum(1 for skill in demand.preferred_skills if skill in verified)
    return round(matched / len(demand.preferred_skills), 4)


def components_for(
    demand: BookingDemand,
    candidate: CandidateFeatures,
    *,
    max_distance_meters: int,
) -> ScoreComponents:
    """Tüm bileşenleri hesaplar."""
    return ScoreComponents(
        skill_score=skill_score(demand, candidate),
        availability_score=availability_score(demand, candidate),
        quality_score=quality_score(candidate),
        distance_score=distance_score(candidate, max_distance_meters=max_distance_meters),
        rating_score=rating_score(candidate),
        preference_score=preference_score(demand, candidate),
    )
