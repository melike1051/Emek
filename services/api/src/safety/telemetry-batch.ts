import { applyDebounce, evaluateGeofence, type DebounceState } from './geofence';
import {
  isIntegrityRejection,
  type GeofenceState,
  type TelemetryRejectionReason,
} from './safety.constants';
import {
  validateSample,
  type TelemetryPolicy,
  type TelemetrySample,
  type TelemetryState,
} from './telemetry-validator';

/**
 * Bir telemetri paketinin oturum üzerindeki etkisi — saf fonksiyon.
 *
 * Üretimde `TelemetryService` bunu kilit altında çağırır ve sonucu yazar; EXP-004
 * harness'i aynı fonksiyonu sentetik izler üzerinde çağırır. Ölçülen ile çalışan
 * aynı koddur. Tek fark mesafenin kaynağıdır: üretimde PostGIS (geography,
 * sferoid), harness'te haversine; fark karar eşiklerinin çok altındadır.
 */

export interface GeofenceConfig {
  radiusMeters: number;
  accuracyLimitMeters: number;
  debounceSamples: number;
}

export interface BatchState {
  telemetry: TelemetryState;
  geofence: DebounceState;
}

export interface AcceptedSample {
  sample: TelemetrySample;
  distanceMeters: number;
  /** Bu tek örneğin gözlemi (debounce öncesi). */
  observation: GeofenceState;
}

export interface GeofenceTransition {
  from: GeofenceState;
  to: GeofenceState;
  sequence: number;
  capturedAt: Date;
  distanceMeters: number;
  accuracyMeters: number;
}

export interface SampleResult {
  sequence: number;
  status: 'ACCEPTED' | 'REJECTED';
  reason: TelemetryRejectionReason | null;
}

export interface BatchOutcome {
  next: BatchState;
  results: SampleResult[];
  accepted: AcceptedSample[];
  transitions: GeofenceTransition[];
  /** Replay dışındaki retler (sayaca girer). */
  countedRejections: number;
  integrityRejections: Map<TelemetryRejectionReason, number>;
  reanchoredSequences: number[];
  mockLocations: number;
}

/**
 * `samples` ve `distances` aynı sırada olmalıdır; fonksiyon örnekleri sıra
 * numarasına göre **kendisi** sıralar (cihaz tamponu sırasız gönderebilir).
 */
export function processBatch(
  state: BatchState,
  samples: readonly TelemetrySample[],
  distances: readonly number[],
  now: Date,
  policy: TelemetryPolicy,
  geofence: GeofenceConfig,
): BatchOutcome {
  const indexed = samples
    .map((sample, index) => ({ sample, distance: distances[index] ?? 0 }))
    .sort((a, b) => a.sample.sequence - b.sample.sequence);

  let telemetry = state.telemetry;
  let debounce = state.geofence;

  const outcome: BatchOutcome = {
    next: state,
    results: [],
    accepted: [],
    transitions: [],
    countedRejections: 0,
    integrityRejections: new Map(),
    reanchoredSequences: [],
    mockLocations: 0,
  };

  for (const { sample, distance } of indexed) {
    const step = validateSample(telemetry, sample, now, policy);
    telemetry = step.next;

    if (step.result.verdict === 'REJECTED') {
      const reason = step.result.reason;
      outcome.results.push({ sequence: sample.sequence, status: 'REJECTED', reason });
      // Replay sayılmaz: ağ yeniden denemesi olağandır ve ret sayacını şişirmek,
      // ret oranı metriğini anlamsızlaştırırdı.
      if (reason !== 'SEQUENCE_REPLAY') {
        outcome.countedRejections += 1;
      }
      if (isIntegrityRejection(reason)) {
        outcome.integrityRejections.set(reason, (outcome.integrityRejections.get(reason) ?? 0) + 1);
      }
      continue;
    }

    const observation = evaluateGeofence({
      distanceMeters: distance,
      accuracyMeters: sample.accuracyMeters,
      radiusMeters: geofence.radiusMeters,
      accuracyLimitMeters: geofence.accuracyLimitMeters,
    }).state;

    const previous = debounce.current;
    const applied = applyDebounce(debounce, observation, geofence.debounceSamples);
    debounce = applied.next;
    if (applied.transitioned) {
      outcome.transitions.push({
        from: previous,
        to: debounce.current,
        sequence: sample.sequence,
        capturedAt: sample.capturedAt,
        distanceMeters: distance,
        accuracyMeters: sample.accuracyMeters,
      });
    }

    if (step.result.reanchored) {
      outcome.reanchoredSequences.push(sample.sequence);
    }
    if (sample.isMockLocation) {
      outcome.mockLocations += 1;
    }
    outcome.accepted.push({ sample, distanceMeters: distance, observation });
    outcome.results.push({ sequence: sample.sequence, status: 'ACCEPTED', reason: null });
  }

  outcome.next = { telemetry, geofence: debounce };
  return outcome;
}
