"""Servisler arası sözleşme testi — AI tarafı.

`packages/api-contracts/matching/` altındaki fixture'lar core'un **gerçek** istemcisi
(`HttpMatchingClient`) tarafından üretilmiş ve bu servisin **gerçek** yanıtından
yakalanmıştır. İki taraf da aynı dosyalara karşı test edilir.

Neden gerekli: iki servis ayrı CI işlerinde koşuyor ve hiçbir test ikisini birlikte
ayağa kaldırmıyor. Alan adlandırmasında (snake_case ↔ camelCase) veya bir alanın
tipinde sessiz bir sapma, üretimde **bozulmuş moda düşmek** olarak görünürdü:
core her çağrıda `INVALID_RESPONSE` alır, kendi yedek sıralamasına düşer ve hiçbir
test kırılmaz. Kullanıcı yalnızca daha kötü eşleşmeler görür.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.matching.schema import SolveRequest, SolveResult

CONTRACT_DIR = Path(__file__).resolve().parents[3] / "packages" / "api-contracts" / "matching"
REQUEST_FIXTURE = CONTRACT_DIR / "solve-request.json"
RESPONSE_FIXTURE = CONTRACT_DIR / "solve-response.json"


@pytest.fixture
def request_payload() -> dict:
    return json.loads(REQUEST_FIXTURE.read_text(encoding="utf-8"))


@pytest.fixture
def response_payload() -> dict:
    return json.loads(RESPONSE_FIXTURE.read_text(encoding="utf-8"))


def test_core_request_validates_against_the_schema(request_payload: dict) -> None:
    """Core'un gönderdiği gövde bu servisin şemasından geçer."""
    parsed = SolveRequest.model_validate(request_payload)

    assert len(parsed.demands) == 1
    assert parsed.demands[0].candidates  # aday havuzu taşınıyor


def test_every_candidate_field_survives_the_round_trip(request_payload: dict) -> None:
    """Alan kaybı sessizdir: eksik bir alan varsayılana düşer ve karar değişir."""
    parsed = SolveRequest.model_validate(request_payload)
    candidate = parsed.demands[0].candidates[0]
    raw = request_payload["demands"][0]["candidates"][0]

    assert str(candidate.provider_id) == raw["provider_id"]
    assert candidate.verified is raw["verified"]
    assert candidate.offers_service is raw["offers_service"]
    assert list(candidate.verified_skills) == raw["verified_skills"]
    assert candidate.distance_meters == raw["distance_meters"]
    assert candidate.daily_booking_count == raw["daily_booking_count"]
    assert candidate.max_daily_bookings == raw["max_daily_bookings"]
    assert candidate.rating_avg == raw["rating_avg"]
    assert candidate.rating_count == raw["rating_count"]
    assert candidate.quality_score == raw["quality_score"]
    assert candidate.completed_bookings == raw["completed_bookings"]
    assert len(candidate.availability) == len(raw["availability"])
    assert {key: value.value for key, value in candidate.skill_levels.items()} == raw[
        "skill_levels"
    ]


def test_response_fixture_is_a_valid_result(response_payload: dict) -> None:
    """Fixture bu servisin gerçek çıktısıdır; şemadan geçmek zorunda."""
    parsed = SolveResult.model_validate(response_payload)

    assert parsed.algorithm_version
    assert parsed.weights_version
    assert parsed.objective_version
    assert parsed.assignments


def test_response_carries_the_fields_core_requires(response_payload: dict) -> None:
    """Core'un `toSolution` doğrulamasının aradığı alanlar.

    Biri eksilirse core yanıtı `INVALID_RESPONSE` sayar ve **sessizce** bozulmuş
    moda düşer; bu test o sessizliği kırar.
    """
    required_top_level = {
        "algorithm_version",
        "weights_version",
        "objective_version",
        "strategy",
        "routing_provider",
        "rankings",
        "assignments",
        "constraint_violations",
        "optimization_runtime_ms",
    }
    assert required_top_level.issubset(response_payload)

    candidate = response_payload["rankings"][0]["candidates"][0]
    assert {
        "provider_id",
        "rank",
        "components",
        "overall_score",
        "explanation",
        "distance_meters",
        "travel_seconds",
    }.issubset(candidate)

    assert {
        "skill_score",
        "availability_score",
        "quality_score",
        "distance_score",
        "rating_score",
        "preference_score",
    } == set(candidate["components"])

    assignment = response_payload["assignments"][0]
    assert {
        "request_id",
        "provider_id",
        "scheduled_start",
        "scheduled_end",
        "travel_seconds",
        "distance_meters",
        "rank",
    }.issubset(assignment)


def test_fixture_response_matches_what_the_engine_produces_today(
    request_payload: dict, response_payload: dict
) -> None:
    """Fixture bayatlamasın: aynı girdi bugün de aynı kararı vermeli.

    Karar değiştiyse bu test kırılır ve iki şeyden biri yapılmalıdır — ya sürüm
    etiketi artırılmalı ya da fixture bilinçli olarak yenilenmeli. Sessizce
    değişen bir karar, sözleşmenin anlamını yitirmesi demektir.
    """
    from app.config import Settings
    from app.matching.engine import solve_request

    settings = Settings()
    produced = solve_request(
        SolveRequest.model_validate(request_payload),
        algorithm_version=settings.matching_algorithm_version,
        weights_version=settings.matching_weights_version,
        objective_version=settings.optimization_objective_version,
        service_timezone=settings.service_timezone,
        max_distance_meters=settings.matching_max_distance_meters,
        time_limit_seconds=settings.optimization_time_limit_seconds,
    )

    expected = SolveResult.model_validate(response_payload)

    assert produced.strategy is expected.strategy
    assert produced.algorithm_version == expected.algorithm_version
    assert produced.weights_version == expected.weights_version
    assert produced.objective_version == expected.objective_version
    assert [
        (str(item.provider_id), item.rank, item.overall_score)
        for item in produced.rankings[0].candidates
    ] == [
        (str(item.provider_id), item.rank, item.overall_score)
        for item in expected.rankings[0].candidates
    ]
    assert [(str(item.provider_id), item.scheduled_start) for item in produced.assignments] == [
        (str(item.provider_id), item.scheduled_start) for item in expected.assignments
    ]
