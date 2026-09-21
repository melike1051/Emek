import type { AnomalyFeatures } from './anomaly.port';
import type { SafetySignals } from './rules/safety-signals';

/** Özellik üretimi için oturumdan gereken alanlar. */
export interface FeatureSource {
  status: 'ARRIVAL_MONITORING' | 'ACTIVE' | string;
  scheduledStart: Date;
  scheduledEnd: Date;
  telemetryIntervalSeconds: number;
  activatedAt: Date | null;
  /** Hizmet noktası. */
  latitude: number;
  longitude: number;
  lastLatitude: number | null;
  lastLongitude: number | null;
}

/**
 * Modele giden özellikler — saf fonksiyon (üretim ve EXP-004 aynı kodu kullanır).
 *
 * Türetilmiş sinyallerdir. Koordinat yalnızca varış aşamasında ve yalnızca rota
 * tahmini için (iki nokta) gider; hizmet sırasında rota bilgisinin güvenlik değeri
 * yoktur ve koordinat göndermenin gerekçesi kalmaz.
 */
export function buildAnomalyFeatures(
  session: FeatureSource,
  signals: SafetySignals,
): AnomalyFeatures {
  const arrival = session.status === 'ARRIVAL_MONITORING';
  const plannedDurationSeconds = Math.max(
    1,
    Math.floor((session.scheduledEnd.getTime() - session.scheduledStart.getTime()) / 1000),
  );

  return {
    sessionStatus: arrival ? 'ARRIVAL_MONITORING' : 'ACTIVE',
    telemetryIntervalSeconds: session.telemetryIntervalSeconds,
    plannedDurationSeconds,
    arrivalDelaySeconds: arrival
      ? Math.floor((signals.evaluatedAt.getTime() - session.scheduledStart.getTime()) / 1000)
      : null,
    elapsedActiveSeconds:
      !arrival && session.activatedAt !== null
        ? Math.max(
            0,
            Math.floor((signals.evaluatedAt.getTime() - session.activatedAt.getTime()) / 1000),
          )
        : null,
    geofenceState: signals.geofenceState,
    geofenceStateSeconds: signals.geofenceStateSeconds,
    secondsSinceTelemetry: signals.secondsSinceTelemetry,
    telemetryCount: signals.telemetryCount,
    rejectedCount: signals.rejectedCount,
    integrityRejectionCount: signals.integrityRejectionCount,
    mockLocationCount: signals.mockLocationCount,
    lastDistanceMeters: signals.lastDistanceMeters,
    recentMovementMeters: signals.recentMovementMeters,
    recentWindowSeconds: signals.recentWindowSeconds,
    distanceTrendMeters: signals.distanceTrendMeters,
    recentLongGapCount: signals.recentLongGapCount,
    recentExitCount: signals.recentExitCount,
    route:
      arrival && session.lastLatitude !== null && session.lastLongitude !== null
        ? {
            origin: { latitude: session.lastLatitude, longitude: session.lastLongitude },
            destination: { latitude: session.latitude, longitude: session.longitude },
          }
        : null,
  };
}
