"""Türkçe metin normalizasyonu.

Türkçe'de `str.lower()` yanlıştır: `"İ".lower()` Python'da `"i̇"` (i + birleşen nokta)
üretir ve `"I".lower()` `"i"` verir — oysa Türkçe'de `I → ı`, `İ → i`'dir. Bu fark
"İSTANBUL" gibi bir girdinin sözlükle eşleşmemesine yol açar.

Ayrıca kullanıcılar Türkçe karakterleri sık sık ASCII yazar ("temizlik" / "temızlık",
"öğleden" / "ogleden"). Sözlük eşleşmesi bu yüzden **katlanmış** (ASCII'ye indirgenmiş)
biçim üzerinden yapılır.
"""

from __future__ import annotations

import re
import unicodedata

_TURKISH_LOWER = str.maketrans(
    {
        "I": "ı",
        "İ": "i",
        "Ş": "ş",
        "Ğ": "ğ",
        "Ü": "ü",
        "Ö": "ö",
        "Ç": "ç",
    }
)

_FOLD = str.maketrans(
    {
        "ı": "i",
        "ş": "s",
        "ğ": "g",
        "ü": "u",
        "ö": "o",
        "ç": "c",
        "â": "a",
        "î": "i",
        "û": "u",
    }
)

_NON_WORD = re.compile(r"[^0-9a-z\s:.\-]+")
_WHITESPACE = re.compile(r"\s+")


def turkish_lower(text: str) -> str:
    """Türkçe kurallarına göre küçük harfe çevirir."""
    return text.translate(_TURKISH_LOWER).lower()


def fold(text: str) -> str:
    """Küçült, Türkçe karakterleri ASCII karşılığına indir, gürültüyü temizle.

    Sonuç sözlük eşleşmesi içindir, kullanıcıya gösterilmez.
    """
    lowered = turkish_lower(text)
    # Birleşik aksanları ayır ve at: "e" + U+0301 → "e".
    decomposed = unicodedata.normalize("NFD", lowered)
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    folded = unicodedata.normalize("NFC", stripped).translate(_FOLD)
    cleaned = _NON_WORD.sub(" ", folded)
    return _WHITESPACE.sub(" ", cleaned).strip()


def tokens(text: str) -> list[str]:
    """Katlanmış metnin kelimeleri."""
    return [token for token in fold(text).split(" ") if token]


#: Türkçe çekim ekleri (katlanmış biçimde), uzundan kısaya.
#:
#: Karakter sayısıyla sınırlama denendi ve **yanlıştı**: üç karakterlik bir bütçe
#: "bebeğime" (bebeğ + im + e) gibi sıradan bir iyelik+hâl yığınını reddediyor,
#: buna karşılık "çamaşır"ın "cam" ile eşleşmesini engellemeye yetmiyordu. Ek,
#: uzunlukla değil **ek listesiyle** tanınır: kökün ardındaki kalıntı, bu listedeki
#: eklere ayrıştırılabiliyorsa gerçek bir çekimdir.
_SUFFIXES: tuple[str, ...] = (
    # çoğul
    "lerden",
    "lardan",
    "lerin",
    "larin",
    "leri",
    "lari",
    "ler",
    "lar",
    # iyelik
    "imiz",
    "iniz",
    "umuz",
    "unuz",
    "miz",
    "niz",
    "muz",
    "nuz",
    "im",
    "in",
    "um",
    "un",
    # hâl
    "den",
    "dan",
    "ten",
    "tan",
    "de",
    "da",
    "te",
    "ta",
    "nin",
    "nun",
    "ni",
    "nu",
    "ne",
    "na",
    "le",
    "la",
    "ile",
    "yle",
    "yla",
    "ye",
    "ya",
    "yi",
    "yu",
    # tekil ünlü ekleri ve kaynaştırma
    "e",
    "a",
    "i",
    "u",
    "m",
    "n",
    "y",
    "s",
)

#: Bir kökün ardına gelebilecek azami ek sayısı ("ev-ler-imiz-den" = 3).
_MAX_SUFFIX_PARTS = 3


def _is_inflection(remainder: str) -> bool:
    """Kalıntı, bilinen eklere ayrıştırılabiliyor mu?

    Açgözlü en-uzun eşleşme yeterli değildir ("leri" mi yoksa "ler"+"i" mi?), bu
    yüzden geri izlemeli denenir. Ayrıştırılamayan kalıntı, kökün aslında başka bir
    kelimenin parçası olduğunu gösterir: "camasir" için "cam" + "asir" çözülemez.
    """
    if remainder == "":
        return True

    def consume(rest: str, depth: int) -> bool:
        if rest == "":
            return True
        if depth == 0:
            return False
        return any(
            rest.startswith(suffix) and consume(rest[len(suffix) :], depth - 1)
            for suffix in _SUFFIXES
        )

    return consume(remainder, _MAX_SUFFIX_PARTS)


def contains_term(folded_text: str, term: str, *, excluded: tuple[str, ...] = ()) -> bool:
    """Terimi kelime sınırında, Türkçe ek toleransıyla arar.

    Türkçe sondan eklemelidir: "temizlik" terimi "temizlikler", "temizliklerden" ile
    eşleşmelidir. Önek serbest değildir ("eltemizlik" eşleşmez).

    `excluded`: kökle başlayan ama **başka bir kelime** olan biçimler. Ek listesi
    "camiye"yi (cam + i + ye) geçerli bir çekim sayar — oysa "cami" ayrı bir kelimedir.
    Bu tür çakışmalar dil bilgisiyle çözülemez; açıkça listelenir.
    """
    pattern = rf"(?<![0-9a-z]){re.escape(term)}([0-9a-z]*)"

    for match in re.finditer(pattern, folded_text):
        word = match.group(0)
        if any(word.startswith(blocked) for blocked in excluded):
            continue
        if _is_inflection(match.group(1)):
            return True

    return False
