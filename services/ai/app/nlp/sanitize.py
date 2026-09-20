"""Girdi temizliği ve prompt injection sınırı (ADR-0007 §"Sonuçlar", T-14).

`raw_text` kullanıcı girdisidir ve **veridir**. Bu modül onu talimat olarak
yorumlamaz; yalnızca boyutunu sınırlar, kontrol karakterlerini atar ve talimat
benzeri içeriği **işaretler** (reddetmek için değil, ölçebilmek için).

Kritik ayrım: "Önceki talimatları unut" yazan bir kullanıcı reddedilmez — böyle bir
cümle meşru metinde de geçebilir. Reddedilmesi gereken şey, o cümlenin sistemin
davranışını değiştirmesidir. Bu garanti mimariden gelir: parser çıktısı kapalı bir
şemadan geçer (schema.py) ve şemada "talimat" diye bir alan yoktur.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Kullanıcı talebi birkaç cümledir. Üst sınır hem maliyet hem DoS yüzeyi içindir.
MAX_RAW_TEXT_LENGTH = 2000

_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_WHITESPACE = re.compile(r"[ \t]+")

# Yalnızca telemetri içindir: "kaç talepte talimat benzeri içerik görüldü?" sorusunu
# ölçebilmek için. Davranışı değiştirmez.
_INSTRUCTION_PATTERNS = (
    re.compile(r"(önceki|yukarıdaki|tüm)\s+(talimat|komut|kural)", re.IGNORECASE),
    re.compile(r"(ignore|disregard|forget)\s+(all\s+)?(previous|above)", re.IGNORECASE),
    re.compile(r"system\s*(prompt|message)", re.IGNORECASE),
    re.compile(r"</?\s*(system|assistant|instruction)\s*>", re.IGNORECASE),
    re.compile(r"\bsen\s+artık\b", re.IGNORECASE),
)


@dataclass(frozen=True)
class SanitizedInput:
    """Temizlenmiş girdi ve temizleme sırasındaki gözlemler."""

    text: str
    warnings: tuple[str, ...]
    #: Talimat benzeri içerik görüldü mü? Yalnızca ölçüm/izleme için.
    instruction_like: bool


def sanitize(raw_text: str) -> SanitizedInput:
    """Girdiyi güvenli sınırlara çeker.

    Boş veya yalnızca boşluktan oluşan girdi burada reddedilmez; ayrıştırıcı bunu
    "hizmet türü anlaşılamadı" olarak ele alır ve netleştirme sorar.
    """
    warnings: list[str] = []

    without_control = _CONTROL_CHARS.sub(" ", raw_text)
    if without_control != raw_text:
        warnings.append("CONTROL_CHARACTERS_REMOVED")

    if len(without_control) > MAX_RAW_TEXT_LENGTH:
        without_control = without_control[:MAX_RAW_TEXT_LENGTH]
        warnings.append("INPUT_TRUNCATED")

    collapsed = _WHITESPACE.sub(" ", without_control).strip()

    instruction_like = any(pattern.search(collapsed) for pattern in _INSTRUCTION_PATTERNS)
    if instruction_like:
        # İşaretlenir ama **reddedilmez ve uygulanmaz**: metin yalnızca veridir.
        warnings.append("INSTRUCTION_LIKE_CONTENT")

    return SanitizedInput(
        text=collapsed,
        warnings=tuple(warnings),
        instruction_like=instruction_like,
    )
