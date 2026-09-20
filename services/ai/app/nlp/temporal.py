"""Türkçe zaman ifadelerinin çözümlenmesi.

Ayrı bir modül: zaman ifadeleri hizmet sözlüğünden bağımsız olarak test edilebilir
olmalı ve Faz 7'de matching tarafında da kullanılacak.

Tüm fonksiyonlar `today` parametresi alır — sistem saatine bağlı olsalardı aynı
girdi farklı günlerde farklı sonuç üretir ve determinizm (ADR-0007 §3) bozulurdu.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, timedelta

from app.nlp.normalize import contains_term
from app.nlp.schema import DayPart, TimeWindow

#: Hafta günleri (katlanmış biçimde) → weekday indeksi.
_WEEKDAYS: dict[str, int] = {
    "pazartesi": 0,
    "sali": 1,
    "carsamba": 2,
    "persembe": 3,
    "cuma": 4,
    "cumartesi": 5,
    "pazar": 6,
}

_DAY_PART_TERMS: tuple[tuple[str, DayPart], ...] = (
    # Sıra önemli: "ogleden sonra" ifadesi "ogle" teriminden önce denenmeli.
    ("ogleden sonra", DayPart.AFTERNOON),
    ("ikindi", DayPart.AFTERNOON),
    ("sabah", DayPart.MORNING),
    ("ogle", DayPart.NOON),
    ("oglen", DayPart.NOON),
    ("aksam", DayPart.EVENING),
    ("gece", DayPart.EVENING),
)

#: Saat aralığı — **en az bir tarafında** açık saat gösterimi (`:` veya `.`) olmalı.
#:
#: Çapasız bir `N-M` kalıbı saat aralığı sayılamaz: "3-5 kişi geliyor" cümlesi
#: 03:00-05:00 randevusuna dönüşürdü ve aynı cümledeki "sabah" ifadesi ezilirdi
#: (Faz 6 review bulgusu C1). Aynı şekilde "10-14 yaş arası çocuk" bir saat aralığı
#: değildir.
_CLOCK_RANGE = re.compile(
    r"(?<![0-9])(?:"
    r"([01]?[0-9]|2[0-3])[:.]([0-5][0-9])\s*(?:-|ile|ila)\s*([01]?[0-9]|2[0-4])(?:[:.][0-5][0-9])?"
    r"|"
    r"([01]?[0-9]|2[0-3])\s*(?:-|ile|ila)\s*([01]?[0-9]|2[0-4])[:.][0-5][0-9]"
    r")"
)

#: Çapasız `N-M` aralığının saat sayılabilmesi için cümlede bulunması gereken ifadeler.
_CLOCK_ANCHORS: tuple[str, ...] = ("saat", "arasi", "arasinda", "sularinda", "civari")

_BARE_RANGE = re.compile(
    r"(?<![0-9])([01]?[0-9]|2[0-3])\s*(?:-|ile|ila)\s*([01]?[0-9]|2[0-4])(?![0-9])"
)

#: Çapa kelimesi olsa bile saat aralığı sayılmayacak bağlamlar ("10-14 yaş arası").
_RANGE_BLOCKERS: tuple[str, ...] = ("yas", "kisi", "metrekare", "m2", "oda", "gun")
_CLOCK_SINGLE = re.compile(r"(?<![0-9])([01]?[0-9]|2[0-3])[:.]([0-5][0-9])")
_DATE_NUMERIC = re.compile(r"(?<![0-9])([0-3]?[0-9])[./]([01]?[0-9])(?:[./](20[0-9]{2}))?(?![0-9])")

_DURATION_HOURS = re.compile(r"(?<![0-9])([0-9]{1,2})(?:[.,]([0-9]))?\s*saat")
_DURATION_MINUTES = re.compile(r"(?<![0-9])([0-9]{1,3})\s*(?:dakika|dk)")


@dataclass(frozen=True)
class TemporalMatch[T]:
    """Bir zaman ifadesinin çözümü ve ne kadar açık olduğunun ölçüsü.

    Jenerik: her çözümleyici kendi tipini döner. Birleşik (`date | TimeWindow | int`)
    bir alan, çağıranı her kullanımda tip daraltmaya zorlar ve hatayı çalışma zamanına
    bırakır.
    """

    value: T
    #: Kanıt gücü: açık ifade (tarih/saat) yüksek, çıkarım (gün adı) daha düşük.
    confidence: float


def resolve_date(folded: str, *, today: date) -> TemporalMatch[date] | None:
    """Metindeki tarihi çözer.

    Öncelik sırası açıklık sırasıdır: sayısal tarih > göreli gün > hafta günü.
    """
    numeric = _DATE_NUMERIC.search(folded)
    if numeric is not None:
        day = int(numeric.group(1))
        month = int(numeric.group(2))
        year = int(numeric.group(3)) if numeric.group(3) else today.year
        try:
            resolved = date(year, month, day)
        except ValueError:
            # 31.02 gibi geçersiz tarih: uydurmak yerine yok sayılır ve netleştirme sorulur.
            return None
        # Yıl verilmediyse ve tarih geçmişte kaldıysa gelecek yıl kastediliyordur.
        if numeric.group(3) is None and resolved < today:
            resolved = date(year + 1, month, day)
        return TemporalMatch(value=resolved, confidence=0.95)

    if contains_term(folded, "bugun"):
        return TemporalMatch(value=today, confidence=0.9)
    if contains_term(folded, "yarin"):
        return TemporalMatch(value=today + timedelta(days=1), confidence=0.9)
    if contains_term(folded, "obur gun") or "obur gun" in folded:
        return TemporalMatch(value=today + timedelta(days=2), confidence=0.85)

    for term, weekday in _WEEKDAYS.items():
        if not contains_term(folded, term):
            continue
        # "haftaya cuma" → bu haftanın cumasını atla.
        next_week = contains_term(folded, "haftaya") or contains_term(folded, "gelecek")
        delta = (weekday - today.weekday()) % 7
        if delta == 0:
            delta = 7
        if next_week and delta < 7:
            delta += 7
        return TemporalMatch(value=today + timedelta(days=delta), confidence=0.75)

    return None


def resolve_time_window(folded: str) -> TemporalMatch[TimeWindow] | None:
    """Saat aralığını veya gün bölümünü çözer.

    Sıra **açıklık sırasıdır**: açık saat gösterimi > tek saat > gün bölümü >
    çapalı çıplak aralık. Çıplak aralık en sona bırakılır, çünkü en zayıf kanıttır;
    önce denenseydi "sabah ... 3-5 kişi" cümlesinde sabahı ezerdi (review bulgusu C1).
    """
    ranged = _CLOCK_RANGE.search(folded)
    if ranged is not None:
        # İki alternatif kalıp: saat solda (1,3) veya sağda (4,5) açık gösterimli.
        start = int(ranged.group(1) or ranged.group(4))
        end = int(ranged.group(3) or ranged.group(5))
        if end > start:
            return TemporalMatch(
                value=TimeWindow(start_hour=start, end_hour=end),
                confidence=0.95,
            )

    single = _CLOCK_SINGLE.search(folded)
    if single is not None:
        start = int(single.group(1))
        # Tek saat verildiğinde bir saatlik bir başlangıç penceresi varsayılır.
        end = min(start + 1, 24)
        if end > start:
            return TemporalMatch(
                value=TimeWindow(start_hour=start, end_hour=end),
                confidence=0.85,
            )

    for term, day_part in _DAY_PART_TERMS:
        if term in folded:
            return TemporalMatch(value=TimeWindow.from_day_part(day_part), confidence=0.7)

    # Çıplak `N-M`: yalnızca cümlede saat çapası varsa ve sayısal aralığı başka bir
    # şeye bağlayan bir kelime (yaş, kişi, oda…) yoksa saat sayılır. En zayıf kanıt
    # olduğu için güveni de düşüktür.
    if any(anchor in folded for anchor in _CLOCK_ANCHORS) and not any(
        blocker in folded for blocker in _RANGE_BLOCKERS
    ):
        bare = _BARE_RANGE.search(folded)
        if bare is not None:
            start = int(bare.group(1))
            end = int(bare.group(2))
            if end > start:
                return TemporalMatch(
                    value=TimeWindow(start_hour=start, end_hour=end),
                    confidence=0.6,
                )

    return None


def resolve_duration(folded: str) -> TemporalMatch[int] | None:
    """Süreyi dakika cinsinden çözer."""
    if contains_term(folded, "yarim gun"):
        return TemporalMatch(value=240, confidence=0.7)
    if contains_term(folded, "tam gun"):
        return TemporalMatch(value=480, confidence=0.7)

    hours = _DURATION_HOURS.search(folded)
    if hours is not None:
        whole = int(hours.group(1))
        fraction = int(hours.group(2)) / 10 if hours.group(2) else 0.0
        minutes = round((whole + fraction) * 60)
        if 30 <= minutes <= 1440:
            return TemporalMatch(value=minutes, confidence=0.95)
        # Aralık dışı süre uydurulmaz: şema zaten reddederdi.
        return None

    explicit_minutes = _DURATION_MINUTES.search(folded)
    if explicit_minutes is not None:
        minutes = int(explicit_minutes.group(1))
        if 30 <= minutes <= 1440:
            return TemporalMatch(value=minutes, confidence=0.9)
        return None

    return None
