import type { SafetySignals } from './safety-signals';

/**
 * Test fixture'ı: olağan (hiçbir kuralın tetiklenmemesi gereken) sinyaller.
 * Kural, toplama ve harness testleri aynı başlangıç noktasını paylaşır.
 */
const EVALUATED_AT = new Date('2026-10-05T12:00:00.000Z');

export function activeSignals(overrides: Partial<SafetySignals> = {}): SafetySignals {
  return {
    sessionStatus: 'ACTIVE',
    evaluatedAt: EVALUATED_AT,
    scheduledStart: new Date('2026-10-05T11:00:00.000Z'),
    scheduledEnd: new Date('2026-10-05T13:00:00.000Z'),
    telemetryIntervalSeconds: 30,
    geofenceRadiusMeters: 150,
    monitoringStartedAt: new Date('2026-10-05T10:30:00.000Z'),
    activatedAt: new Date('2026-10-05T11:00:00.000Z'),
    activationGeofenceState: 'INSIDE',
    geofenceState: 'INSIDE',
    geofenceStateSeconds: 3600,
    lastDistanceMeters: 20,
    secondsSinceTelemetry: 30,
    telemetryCount: 120,
    rejectedCount: 0,
    integrityRejectionCount: 0,
    mockLocationCount: 0,
    recentMovementMeters: 300,
    recentWindowSeconds: 3000,
    recentSampleCount: 100,
    distanceTrendMeters: 0,
    recentLongGapCount: 0,
    recentExitCount: 0,
    geofenceEvidenceAgeSeconds: 30,
    geofenceEvidenceSide: 'INSIDE',
    routeEtaSeconds: null,
    routeProvider: null,
    unavailable: [],
    ...overrides,
  };
}

export function arrivalSignals(overrides: Partial<SafetySignals> = {}): SafetySignals {
  return activeSignals({
    sessionStatus: 'ARRIVAL_MONITORING',
    evaluatedAt: new Date('2026-10-05T10:45:00.000Z'),
    activatedAt: null,
    activationGeofenceState: null,
    geofenceState: 'OUTSIDE',
    geofenceStateSeconds: 900,
    lastDistanceMeters: 3000,
    recentMovementMeters: 2500,
    recentWindowSeconds: 900,
    distanceTrendMeters: -2500,
    geofenceEvidenceSide: 'OUTSIDE',
    routeEtaSeconds: 600,
    routeProvider: 'haversine',
    ...overrides,
  });
}
