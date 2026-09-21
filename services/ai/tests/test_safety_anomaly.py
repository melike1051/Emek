"""Anomali modeli: determinizm, açıklanabilirlik, kalite ve rota bozulması."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest
from pydantic import ValidationError

from app.matching.schema import Location
from app.routing.haversine import HaversineRouter
from app.routing.port import RoutingUnavailableError, TravelEstimate
from app.safety import model, service
from app.safety.schema import AnomalyRequest


def _active(**overrides: Any) -> AnomalyRequest:
    payload: dict[str, Any] = {
        "session_status": "ACTIVE",
        "telemetry_interval_seconds": 30,
        "planned_duration_seconds": 7200,
        "elapsed_active_seconds": 3600,
        "geofence_state": "INSIDE",
        "geofence_state_seconds": 3000,
        "seconds_since_telemetry": 30,
        "telemetry_count": 120,
        "rejected_count": 0,
        "integrity_rejection_count": 0,
        "mock_location_count": 0,
        "last_distance_meters": 20,
        "recent_movement_meters": 200,
        "recent_window_seconds": 1800,
        "distance_trend_meters": 0,
        "recent_long_gap_count": 0,
        "recent_exit_count": 0,
    }
    payload.update(overrides)
    return AnomalyRequest.model_validate(payload)


def _arrival(**overrides: Any) -> AnomalyRequest:
    payload: dict[str, Any] = {
        "session_status": "ARRIVAL_MONITORING",
        "telemetry_interval_seconds": 30,
        "planned_duration_seconds": 7200,
        "arrival_delay_seconds": -1200,
        "geofence_state": "OUTSIDE",
        "geofence_state_seconds": 600,
        "seconds_since_telemetry": 30,
        "telemetry_count": 20,
        "rejected_count": 0,
        "integrity_rejection_count": 0,
        "mock_location_count": 0,
        "last_distance_meters": 3000,
        "recent_movement_meters": 2000,
        "recent_window_seconds": 600,
        "distance_trend_meters": -1500,
        "recent_long_gap_count": 0,
        "recent_exit_count": 0,
        "route": {
            "origin": {"latitude": 41.0, "longitude": 29.0},
            "destination": {"latitude": 41.02, "longitude": 29.02},
        },
    }
    payload.update(overrides)
    return AnomalyRequest.model_validate(payload)


def test_normal_active_session_scores_low_with_full_quality() -> None:
    result = model.assess(_active(), None)

    assert result.score < 0.1
    assert result.quality == 1.0
    assert result.unavailable == []


def test_abnormal_active_session_scores_high_and_explains_itself() -> None:
    """Uzun süre dışarıda + telemetri sessiz: skor yüksek, katkılar sıralı."""
    result = model.assess(
        _active(
            geofence_state="OUTSIDE",
            geofence_state_seconds=1800,
            seconds_since_telemetry=1500,
        ),
        None,
    )

    assert result.score >= 0.8
    top = [item.feature for item in result.contributions[:2]]
    assert set(top) == {"outside_dwell", "telemetry_gap"}
    # Katkılar büyükten küçüğe: "neden" sorusunun cevabı ilk satırda.
    assert result.contributions == sorted(
        result.contributions, key=lambda item: (-item.contribution, item.feature)
    )


def test_several_small_deviations_combine() -> None:
    """Kuralların eşiğinin altında kalan küçük sapmalar birlikte skoru yükseltir."""
    single = model.assess(_active(elapsed_active_seconds=int(7200 * 1.6)), None).score
    combined = model.assess(
        _active(
            elapsed_active_seconds=int(7200 * 1.6),
            seconds_since_telemetry=600,
            integrity_rejection_count=10,
        ),
        None,
    ).score

    assert combined > single


def test_single_feature_can_not_reach_certainty() -> None:
    """Ağırlıklar < 1: tek sinyal tam sapmada bile skoru 1'e taşımaz."""
    result = model.assess(_active(seconds_since_telemetry=100_000), None)

    assert result.score < 1.0
    assert result.score == pytest.approx(model.FEATURES["telemetry_gap"].weight)


def test_assessment_is_deterministic() -> None:
    request = _active(geofence_state="OUTSIDE", geofence_state_seconds=700)

    assert model.assess(request, None) == model.assess(request, None)


def test_unknown_geofence_is_unavailable_not_normal() -> None:
    """Zayıf GPS "bilmiyoruz"dur: sapma sayılmaz ama kaliteyi düşürür."""
    result = model.assess(
        _active(geofence_state="INSUFFICIENT_ACCURACY", geofence_state_seconds=None), None
    )

    assert "outside_dwell" in result.unavailable
    assert result.quality < 1.0


def test_missing_telemetry_lowers_quality() -> None:
    result = model.assess(
        _active(
            seconds_since_telemetry=None,
            telemetry_count=0,
            geofence_state="UNKNOWN",
            geofence_state_seconds=None,
        ),
        None,
    )

    assert {"telemetry_gap", "mock_rate", "outside_dwell"} <= set(result.unavailable)
    assert result.quality <= 0.5


def test_active_phase_has_no_inactivity_feature() -> None:
    """GPS daire içindeki hareketi göremez: hareketsiz görünen iş sapma değildir."""
    still = model.assess(_active(recent_movement_meters=0, recent_window_seconds=7200), None)

    assert still.score < 0.1
    assert all(item.feature != "stalled" for item in still.contributions)


def test_stalled_far_from_service_is_a_deviation() -> None:
    stalled = model.assess(
        _arrival(recent_movement_meters=10, recent_window_seconds=1800, last_distance_meters=4000),
        600,
    )
    waiting_nearby = model.assess(
        _arrival(recent_movement_meters=0, recent_window_seconds=1800, last_distance_meters=200),
        60,
    )

    assert any(
        item.feature == "stalled" and item.deviation == 1.0 for item in stalled.contributions
    )
    assert all(
        item.contribution == 0.0
        for item in waiting_nearby.contributions
        if item.feature == "stalled"
    )


def test_short_window_does_not_imply_stall() -> None:
    result = model.assess(_arrival(recent_movement_meters=0, recent_window_seconds=300), 600)

    assert "stalled" in result.unavailable


def test_projected_lateness_requires_route() -> None:
    request = _arrival(arrival_delay_seconds=0)

    without_route = model.assess(request, None)
    with_route = model.assess(request, 3000)

    assert "projected_lateness" in without_route.unavailable
    assert "projected_lateness" not in with_route.unavailable
    assert with_route.score > without_route.score


def test_moving_away_during_arrival_is_a_deviation() -> None:
    approaching = model.assess(_arrival(), 600).score
    leaving = model.assess(_arrival(distance_trend_meters=2500), 600).score

    assert leaving > approaching


def test_schema_rejects_phase_inconsistent_payloads() -> None:
    with pytest.raises(ValidationError):
        _active(
            route={
                "origin": {"latitude": 41.0, "longitude": 29.0},
                "destination": {"latitude": 41.0, "longitude": 29.0},
            }
        )
    with pytest.raises(ValidationError):
        _arrival(elapsed_active_seconds=10)


def test_schema_rejects_unknown_fields_and_out_of_range_values() -> None:
    with pytest.raises(ValidationError):
        _active(user_id="leak")
    with pytest.raises(ValidationError):
        _active(telemetry_count=-1)
    with pytest.raises(ValidationError):
        _active(geofence_state="SOMEWHERE")


@dataclass
class _FailingRouter:
    @property
    def name(self) -> str:
        return "failing"

    def estimate(self, origin: Location, destination: Location) -> TravelEstimate:
        raise RoutingUnavailableError("down")

    def estimate_from_distance(self, distance_meters: int) -> TravelEstimate:
        raise RoutingUnavailableError("down")


def test_route_uses_phase7_routing_port() -> None:
    response = service.assess(_arrival(), HaversineRouter(), model.MODEL_VERSION)

    assert response.route is not None
    assert response.route.available is True
    assert response.route.provider == "haversine"
    assert response.route.eta_seconds is not None and response.route.eta_seconds > 0


def test_route_failure_is_reported_not_fabricated() -> None:
    """Rota sağlayıcısı düşerse ETA uydurulmaz ve skor rotasız hesaplanır."""
    response = service.assess(_arrival(), _FailingRouter(), model.MODEL_VERSION)

    assert response.route is not None
    assert response.route.available is False
    assert response.route.eta_seconds is None
    assert "projected_lateness" in response.unavailable_features


def test_active_session_has_no_route() -> None:
    response = service.assess(_active(), HaversineRouter(), model.MODEL_VERSION)

    assert response.route is None


def test_v1_ignores_session_history_v2_uses_it() -> None:
    """v2: tekrarlayan kısa sapmalar birlikte sapmadır; v1 bunları göremez."""
    request = _active(recent_long_gap_count=3, recent_exit_count=3)

    v1 = model.assess(request, None, model.MODEL_V1)
    v2 = model.assess(request, None, model.MODEL_V2)

    assert v1.score < 0.1
    assert v2.score >= 0.8
    assert {item.feature for item in v2.contributions} >= {"repeated_gaps", "repeated_exits"}


def test_single_gap_or_exit_is_not_a_deviation() -> None:
    result = model.assess(_active(recent_long_gap_count=1, recent_exit_count=1), None)

    assert result.score < 0.1


def test_exits_are_not_counted_during_arrival() -> None:
    """Varışta "çıkış" kavramı yoktur: özellik hiç yoktur, kaliteyi şişirmez."""
    result = model.assess(_arrival(recent_long_gap_count=0, recent_exit_count=5), 600)

    assert all(item.feature != "repeated_exits" for item in result.contributions)
    assert "repeated_exits" not in result.unavailable


@pytest.mark.parametrize(
    "request_",
    [
        _active(geofence_state="OUTSIDE", geofence_state_seconds=900, seconds_since_telemetry=700),
        _active(recent_long_gap_count=2, recent_exit_count=3, elapsed_active_seconds=10_000),
        _arrival(arrival_delay_seconds=1200, distance_trend_meters=1800),
    ],
)
def test_score_is_noisy_or_of_contributions(request_: AnomalyRequest) -> None:
    """Core'un bağımsız kanıt hesabı bu sözleşmeye dayanır (risk-agg-v2)."""
    result = model.assess(request_, 900)

    survival = 1.0
    for item in result.contributions:
        survival *= 1.0 - item.contribution
    assert result.score == pytest.approx(1.0 - survival, abs=5e-4)


def test_unknown_model_version_is_rejected() -> None:
    with pytest.raises(ValueError, match="bilinmeyen model sürümü"):
        model.assess(_active(), None, "anomaly-deviation-v0")
