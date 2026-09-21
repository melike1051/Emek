"""EXP-004 toplu skorlayıcı: endpoint ile aynı sonucu üretir."""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from app.config import get_settings
from app.evaluation.safety.score import score
from app.main import API_PREFIX, create_app

REQUEST: dict[str, object] = {
    "session_status": "ARRIVAL_MONITORING",
    "telemetry_interval_seconds": 30,
    "planned_duration_seconds": 7200,
    "arrival_delay_seconds": 600,
    "geofence_state": "OUTSIDE",
    "geofence_state_seconds": 900,
    "seconds_since_telemetry": 400,
    "telemetry_count": 30,
    "rejected_count": 1,
    "integrity_rejection_count": 1,
    "mock_location_count": 0,
    "last_distance_meters": 4000,
    "recent_movement_meters": 3000,
    "recent_window_seconds": 900,
    "distance_trend_meters": 900,
    "route": {
        "origin": {"latitude": 41.03, "longitude": 29.0},
        "destination": {"latitude": 41.0, "longitude": 29.0},
    },
}


def test_batch_scoring_matches_endpoint() -> None:
    get_settings.cache_clear()
    batch = json.loads(score(json.dumps([REQUEST, REQUEST])))
    endpoint = TestClient(create_app()).post(f"{API_PREFIX}/safety/anomaly", json=REQUEST).json()

    assert batch == [endpoint, endpoint]
