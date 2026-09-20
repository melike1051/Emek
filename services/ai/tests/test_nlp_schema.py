"""Şema sınırları (T-13).

Şema güvenlik sınırıdır: doğrulanmamış bir model çıktısı iş kuralına giremez
(ADR-0007 §2). Bu testler "şema gerçekten reddediyor mu?" sorusunu yanıtlar.
"""

from datetime import date

import pytest
from pydantic import ValidationError

from app.nlp.schema import (
    ClarificationQuestion,
    DayPart,
    FieldConfidence,
    ParseResult,
    ParseStatus,
    StructuredRequest,
    TimeWindow,
)


def test_unknown_service_type_is_rejected() -> None:
    """Model uydurduğu bir hizmet adını şemadan geçiremez."""
    with pytest.raises(ValidationError):
        StructuredRequest(service_type="ev-boyama", duration_minutes=120)  # type: ignore[arg-type]


def test_duration_outside_bounds_is_rejected() -> None:
    # "40 saat temizlik" gibi bir çıktı iş kuralına girmemeli.
    with pytest.raises(ValidationError):
        StructuredRequest(service_type="standart-temizlik", duration_minutes=2400)
    with pytest.raises(ValidationError):
        StructuredRequest(service_type="standart-temizlik", duration_minutes=5)


def test_unknown_requirement_is_rejected() -> None:
    with pytest.raises(ValidationError):
        StructuredRequest(
            service_type="standart-temizlik",
            duration_minutes=180,
            requirements=("ücretsiz-hizmet",),  # type: ignore[arg-type]
        )


def test_duplicate_requirements_are_rejected() -> None:
    with pytest.raises(ValidationError):
        StructuredRequest(
            service_type="standart-temizlik",
            duration_minutes=180,
            requirements=("utu", "utu"),
        )


def test_time_window_must_be_ordered() -> None:
    with pytest.raises(ValidationError):
        TimeWindow(start_hour=18, end_hour=9)


def test_day_part_window_matches_shared_table() -> None:
    window = TimeWindow.from_day_part(DayPart.AFTERNOON)

    assert (window.start_hour, window.end_hour) == (13, 18)
    assert window.day_part is DayPart.AFTERNOON


def test_parsed_result_requires_request() -> None:
    """PARSED ama içi boş bir sonuç, core tarafında sessiz bir None üretirdi."""
    with pytest.raises(ValidationError):
        ParseResult(status=ParseStatus.PARSED, parser_version="x", confidence=0.9)


def test_clarification_result_requires_question() -> None:
    with pytest.raises(ValidationError):
        ParseResult(
            status=ParseStatus.NEEDS_CLARIFICATION, parser_version="x", confidence=0.2
        )


def test_rejected_result_cannot_carry_request() -> None:
    with pytest.raises(ValidationError):
        ParseResult(
            status=ParseStatus.REJECTED,
            parser_version="x",
            confidence=0.0,
            request=StructuredRequest(service_type="standart-temizlik", duration_minutes=180),
        )


def test_parser_version_is_mandatory() -> None:
    """Sürümsüz çıktı geriye dönük deney yapmayı imkânsız kılar (ADR-0012 §1)."""
    with pytest.raises(ValidationError):
        ParseResult(
            status=ParseStatus.NEEDS_CLARIFICATION,
            parser_version="",
            confidence=0.1,
            clarifications=(
                ClarificationQuestion(field="service_type", question="Hangi hizmet?"),
            ),
        )


def test_confidence_is_bounded() -> None:
    with pytest.raises(ValidationError):
        FieldConfidence(
            service_type=1.5,
            duration_minutes=0.5,
            service_date=0.5,
            time_window=0.5,
            requirements=0.5,
        )


def test_structured_request_is_immutable() -> None:
    """Doğrulanmış talep sonradan değiştirilemez: doğrulama tek seferliktir."""
    request = StructuredRequest(
        service_type="standart-temizlik",
        duration_minutes=180,
        service_date=date(2026, 3, 3),
    )

    with pytest.raises(ValidationError):
        request.duration_minutes = 999  # type: ignore[misc]
