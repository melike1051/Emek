"""Parser portu ve sürüm kaydı (ADR-0012 §1).

Parser'lar sürüm adıyla kaydedilir. Bir yanıtın hangi sürümle üretildiği
`ParseResult.parser_version` alanında taşınır ve core tarafında
`booking_requests.parser_version` kolonuna yazılır — deney karşılaştırması
(baseline vs proposed) bu bilgi olmadan yapılamaz.
"""

from __future__ import annotations

from datetime import date
from typing import Protocol, runtime_checkable

from app.nlp.schema import ParseResult


@runtime_checkable
class RequestParser(Protocol):
    """Serbest metni yapılandırılmış talebe çeviren bileşen."""

    @property
    def version(self) -> str:
        """Sürüm etiketi; sonuçla birlikte saklanır."""
        ...

    def parse(self, raw_text: str, *, today: date) -> ParseResult:
        """Metni ayrıştırır.

        `today` dışarıdan verilir: "yarın" gibi göreli ifadeler sistem saatine
        bağlı olsaydı testler zamana göre kırılgan olurdu ve aynı girdi farklı
        günlerde farklı sonuç üretirdi (determinizm — ADR-0007 §3).
        """
        ...


class ParserRegistry:
    """Sürüm → parser eşlemesi.

    Kayıtlı olmayan bir sürüm istenirse hata verilir; sessizce varsayılana düşmek,
    deney sonuçlarının yanlış sürüme atfedilmesine yol açardı.
    """

    def __init__(self) -> None:
        self._parsers: dict[str, RequestParser] = {}

    def register(self, parser: RequestParser) -> None:
        if parser.version in self._parsers:
            raise ValueError(f"parser sürümü zaten kayıtlı: {parser.version}")
        self._parsers[parser.version] = parser

    def get(self, version: str) -> RequestParser:
        try:
            return self._parsers[version]
        except KeyError as error:
            known = ", ".join(sorted(self._parsers))
            raise KeyError(f"bilinmeyen parser sürümü: {version} (kayıtlı: {known})") from error

    def versions(self) -> tuple[str, ...]:
        return tuple(sorted(self._parsers))
