"""Matching testleri için ortak kurgu yardımcıları.

Testler kurgu kurmakla değil **davranış doğrulamakla** ilgilenmeli; bu yüzden
varsayılanlar "geçerli aday" üretir ve her test yalnızca bozmak istediği alanı
geçersiz kılar. Böylece bir testin neyi ölçtüğü tek satırda okunur.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from app.matching.schema import (
    BookingDemand,
    CandidateFeatures,
    Interval,
    Location,
    SkillLevel,
)

#: Tüm testlerde ortak referans an. Sabit: "şimdi"ye bağlı test zamanla kırılır.
EPOCH = datetime(2026, 10, 5, 6, 0, tzinfo=UTC)

CUSTOMER_LOCATION = Location(latitude=41.0000, longitude=29.0000)


def provider_id(index: int) -> UUID:
    return UUID(int=index)


def request_id(index: int) -> UUID:
    return UUID(int=1000 + index)


def window(*, start_hour: int = 0, length_hours: int = 8) -> Interval:
    return Interval(
        start=EPOCH + timedelta(hours=start_hour),
        end=EPOCH + timedelta(hours=start_hour + length_hours),
    )


def candidate(index: int, **overrides: Any) -> CandidateFeatures:
    """Varsayılan olarak **geçerli** bir aday."""
    defaults: dict[str, Any] = {
        "provider_id": provider_id(index),
        "verified": True,
        "offers_service": True,
        "verified_skills": ("derin-temizlik",),
        "availability": (window(),),
        "has_conflicting_booking": False,
        "within_service_area": True,
        "distance_meters": 2_000,
        "daily_booking_count": 0,
        "max_daily_bookings": 2,
        "skill_levels": {"derin-temizlik": SkillLevel.EXPERT},
        "rating_avg": 4.6,
        "rating_count": 20,
        "quality_score": 0.9,
        "completed_bookings": 40,
        "home_location": Location(latitude=41.0100, longitude=29.0100),
    }
    defaults.update(overrides)
    return CandidateFeatures(**defaults)


def demand(index: int = 0, **overrides: Any) -> BookingDemand:
    """Varsayılan olarak tek geçerli adayı olan bir talep."""
    defaults: dict[str, Any] = {
        "request_id": request_id(index),
        "service_type": "detayli-temizlik",
        "duration_minutes": 180,
        "window": window(),
        "location": CUSTOMER_LOCATION,
        "required_skills": ("derin-temizlik",),
        "preferred_skills": (),
        "candidates": (candidate(1),),
    }
    defaults.update(overrides)
    return BookingDemand(**defaults)
