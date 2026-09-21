import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { UnitOfWork } from '../common/database/unit-of-work';
import type { TraceSample } from './rules/safety-signals';
import type {
  GeofenceState,
  RiskLevel,
  SafetyClosureReason,
  SafetyEventSource,
  SafetyEventType,
  SafetySessionStatus,
} from './safety.constants';

export interface SafetySession {
  id: string;
  bookingId: string;
  providerId: string;
  customerId: string;
  status: SafetySessionStatus;
  riskLevel: RiskLevel;
  /** Hizmet noktası; operatör ve geofence için. Katılımcı yanıtına **girmez**. */
  latitude: number;
  longitude: number;
  geofenceRadiusMeters: number;
  geofenceAccuracyLimitMeters: number;
  geofenceDebounceSamples: number;
  geofenceState: GeofenceState;
  geofenceStateSince: Date | null;
  geofenceCandidateState: GeofenceState | null;
  geofenceCandidateCount: number;
  activationGeofenceState: GeofenceState | null;
  telemetryIntervalSeconds: number;
  telemetryMaxSkewSeconds: number;
  telemetryMaxAgeSeconds: number;
  lastSequence: number;
  lastTelemetryAt: Date | null;
  lastCapturedAt: Date | null;
  lastDistanceMeters: number | null;
  lastLatitude: number | null;
  lastLongitude: number | null;
  lastAccuracyMeters: number | null;
  consecutiveSpeedRejections: number;
  telemetryCount: number;
  rejectedCount: number;
  integrityRejectionCount: number;
  mockLocationCount: number;
  scheduledStart: Date;
  scheduledEnd: Date;
  monitoringStartedAt: Date | null;
  activatedAt: Date | null;
  closedAt: Date | null;
  closureReason: SafetyClosureReason | null;
  nextEvaluationAt: Date | null;
  lastEvaluatedAt: Date | null;
  activeRules: string[];
  anomalyFlagged: boolean;
  panicRaisedAt: Date | null;
  panicCount: number;
  emergencyResolvedAt: Date | null;
  retentionExpiresAt: Date;
  locationPurgedAt: Date | null;
  createdAt: Date;
}

interface SessionRow {
  id: string;
  booking_id: string;
  provider_id: string;
  customer_id: string;
  status: SafetySessionStatus;
  risk_level: RiskLevel;
  latitude: number;
  longitude: number;
  geofence_radius_meters: number;
  geofence_accuracy_limit_meters: number;
  geofence_debounce_samples: number;
  geofence_state: GeofenceState;
  geofence_state_since: Date | null;
  geofence_candidate_state: GeofenceState | null;
  geofence_candidate_count: number;
  activation_geofence_state: GeofenceState | null;
  telemetry_interval_seconds: number;
  telemetry_max_skew_seconds: number;
  telemetry_max_age_seconds: number;
  last_sequence: string;
  last_telemetry_at: Date | null;
  last_captured_at: Date | null;
  last_distance_meters: number | null;
  last_latitude: number | null;
  last_longitude: number | null;
  last_accuracy_meters: number | null;
  consecutive_speed_rejections: number;
  telemetry_count: number;
  rejected_count: number;
  integrity_rejection_count: number;
  mock_location_count: number;
  scheduled_start: Date;
  scheduled_end: Date;
  monitoring_started_at: Date | null;
  activated_at: Date | null;
  closed_at: Date | null;
  closure_reason: SafetyClosureReason | null;
  next_evaluation_at: Date | null;
  last_evaluated_at: Date | null;
  active_rules: string[];
  anomaly_flagged: boolean;
  panic_raised_at: Date | null;
  panic_count: number;
  emergency_resolved_at: Date | null;
  retention_expires_at: Date;
  location_purged_at: Date | null;
  created_at: Date;
}

/**
 * Kolon listesi tek yerde tutulur ki okuma yolları ayrışmasın.
 * `service_location` geography olarak saklanır; okurken lat/lon'a açılır.
 */
const SELECT_SESSION = `
  SELECT id, booking_id, provider_id, customer_id, status, risk_level,
         ST_Y(service_location::geometry) AS latitude,
         ST_X(service_location::geometry) AS longitude,
         geofence_radius_meters, geofence_accuracy_limit_meters, geofence_debounce_samples,
         geofence_state, geofence_state_since,
         geofence_candidate_state, geofence_candidate_count, activation_geofence_state,
         telemetry_interval_seconds, telemetry_max_skew_seconds, telemetry_max_age_seconds,
         last_sequence::text AS last_sequence, last_telemetry_at, last_captured_at,
         last_distance_meters, last_latitude, last_longitude, last_accuracy_meters,
         consecutive_speed_rejections,
         telemetry_count, rejected_count, integrity_rejection_count, mock_location_count,
         scheduled_start, scheduled_end, monitoring_started_at, activated_at,
         closed_at, closure_reason, next_evaluation_at, last_evaluated_at,
         active_rules, anomaly_flagged, panic_raised_at, panic_count, emergency_resolved_at,
         retention_expires_at, location_purged_at, created_at
    FROM safety_sessions
`;

function nullableNumber(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function toSession(row: SessionRow): SafetySession {
  return {
    id: row.id,
    bookingId: row.booking_id,
    providerId: row.provider_id,
    customerId: row.customer_id,
    status: row.status,
    riskLevel: row.risk_level,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    geofenceRadiusMeters: Number(row.geofence_radius_meters),
    geofenceAccuracyLimitMeters: Number(row.geofence_accuracy_limit_meters),
    geofenceDebounceSamples: Number(row.geofence_debounce_samples),
    geofenceState: row.geofence_state,
    geofenceStateSince: row.geofence_state_since,
    geofenceCandidateState: row.geofence_candidate_state,
    geofenceCandidateCount: Number(row.geofence_candidate_count),
    activationGeofenceState: row.activation_geofence_state,
    telemetryIntervalSeconds: Number(row.telemetry_interval_seconds),
    telemetryMaxSkewSeconds: Number(row.telemetry_max_skew_seconds),
    telemetryMaxAgeSeconds: Number(row.telemetry_max_age_seconds),
    // BIGINT; sözleşme sıra numarasını Number.MAX_SAFE_INTEGER ile sınırlar.
    lastSequence: Number(row.last_sequence),
    lastTelemetryAt: row.last_telemetry_at,
    lastCapturedAt: row.last_captured_at,
    lastDistanceMeters: nullableNumber(row.last_distance_meters),
    lastLatitude: nullableNumber(row.last_latitude),
    lastLongitude: nullableNumber(row.last_longitude),
    lastAccuracyMeters: nullableNumber(row.last_accuracy_meters),
    consecutiveSpeedRejections: Number(row.consecutive_speed_rejections),
    telemetryCount: Number(row.telemetry_count),
    rejectedCount: Number(row.rejected_count),
    integrityRejectionCount: Number(row.integrity_rejection_count),
    mockLocationCount: Number(row.mock_location_count),
    scheduledStart: row.scheduled_start,
    scheduledEnd: row.scheduled_end,
    monitoringStartedAt: row.monitoring_started_at,
    activatedAt: row.activated_at,
    closedAt: row.closed_at,
    closureReason: row.closure_reason,
    nextEvaluationAt: row.next_evaluation_at,
    lastEvaluatedAt: row.last_evaluated_at,
    activeRules: row.active_rules,
    anomalyFlagged: row.anomaly_flagged,
    panicRaisedAt: row.panic_raised_at,
    panicCount: Number(row.panic_count),
    emergencyResolvedAt: row.emergency_resolved_at,
    retentionExpiresAt: row.retention_expires_at,
    locationPurgedAt: row.location_purged_at,
    createdAt: row.created_at,
  };
}

export interface SessionPolicy {
  radiusMeters: number;
  accuracyLimitMeters: number;
  debounceSamples: number;
  telemetryIntervalSeconds: number;
  telemetryMaxSkewSeconds: number;
  telemetryMaxAgeSeconds: number;
  retentionDays: number;
}

export interface LocationEventRow {
  sequence: number;
  capturedAt: Date;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  speedMps: number | null;
  headingDegrees: number | null;
  isMockLocation: boolean;
  distanceMeters: number;
  geofenceState: GeofenceState;
}

export interface SafetyEventRecord {
  id: string;
  eventType: SafetyEventType;
  source: SafetyEventSource;
  riskLevel: RiskLevel;
  ruleId: string | null;
  ruleVersion: string | null;
  modelVersion: string | null;
  anomalyScore: number | null;
  occurredAt: Date;
  details: Record<string, unknown>;
}

export interface AssessmentRecord {
  id: string;
  riskLevel: RiskLevel;
  computedRiskLevel: RiskLevel;
  previousRiskLevel: RiskLevel;
  determinedBy: string;
  rulesetVersion: string;
  aggregationVersion: string;
  triggeredRules: unknown[];
  anomalyModelVersion: string | null;
  anomalyScore: number | null;
  anomalyQuality: number | null;
  anomalyAvailable: boolean;
  anomalyUnavailableReason: string | null;
  anomalyContributions: unknown[];
  routeProvider: string | null;
  unavailableSignals: string[];
  signals: Record<string, unknown>;
  evaluatedAt: Date;
  latencyMs: number;
}

/** Etkin panik: kaydedilmiş ve operatör tarafından henüz çözülmemiş. */
export function isPanicActive(session: {
  panicRaisedAt: Date | null;
  emergencyResolvedAt: Date | null;
}): boolean {
  return session.panicRaisedAt !== null && session.emergencyResolvedAt === null;
}

@Injectable()
export class SafetyRepository {
  constructor(private readonly uow: UnitOfWork) {}

  /**
   * Rezervasyondan oturum açar; açık oturum zaten varsa hiçbir şey yapmaz.
   *
   * `ON CONFLICT ... DO NOTHING` kısmi unique index'e dayanır: eşzamanlı iki açma
   * denemesinden yalnızca biri satır ekler, diğeri sessizce mevcut oturumu bulur.
   * Uygulama tarafında "önce var mı diye bak" kontrolü tek başına yarışa açıktı.
   *
   * Hizmet noktası ve zaman penceresi rezervasyondan **kopyalanır**: adres sonradan
   * arşivlense bile oturumun geofence merkezi değişmemeli.
   */
  async openSession(
    client: PoolClient,
    bookingId: string,
    policy: SessionPolicy,
  ): Promise<{ session: SafetySession; created: boolean } | null> {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO safety_sessions
         (booking_id, provider_id, customer_id, service_location,
          geofence_radius_meters, geofence_accuracy_limit_meters, geofence_debounce_samples,
          telemetry_interval_seconds, telemetry_max_skew_seconds, telemetry_max_age_seconds,
          scheduled_start, scheduled_end, retention_expires_at, status)
       SELECT b.id, b.provider_id, b.customer_id, a.location,
              $2, $3, $4, $5, $6, $7,
              b.scheduled_start, b.scheduled_end,
              b.scheduled_end + make_interval(days => $8::int),
              'PRE_SERVICE'
         FROM bookings b
         JOIN addresses a ON a.id = b.address_id
        WHERE b.id = $1 AND b.provider_id IS NOT NULL
       ON CONFLICT (booking_id) WHERE status <> 'CLOSED' DO NOTHING
       RETURNING id`,
      [
        bookingId,
        policy.radiusMeters,
        policy.accuracyLimitMeters,
        policy.debounceSamples,
        policy.telemetryIntervalSeconds,
        policy.telemetryMaxSkewSeconds,
        policy.telemetryMaxAgeSeconds,
        policy.retentionDays,
      ],
    );

    const createdId = inserted.rows[0]?.id;
    const session =
      createdId === undefined
        ? await this.lockOpenSessionByBooking(client, bookingId)
        : await this.lockSession(client, createdId);
    return session === null ? null : { session, created: createdId !== undefined };
  }

  /** Oturumu kilitleyerek okur — durum değiştiren her akış bunu kullanır. */
  async lockSession(client: PoolClient, sessionId: string): Promise<SafetySession | null> {
    const rows = await client.query<SessionRow>(`${SELECT_SESSION} WHERE id = $1 FOR UPDATE`, [
      sessionId,
    ]);
    const row = rows.rows[0];
    return row === undefined ? null : toSession(row);
  }

  /** Rezervasyonun açık oturumu (varsa), kilitlenmiş hâlde. */
  async lockOpenSessionByBooking(
    client: PoolClient,
    bookingId: string,
  ): Promise<SafetySession | null> {
    const rows = await client.query<SessionRow>(
      `${SELECT_SESSION} WHERE booking_id = $1 AND status <> 'CLOSED' FOR UPDATE`,
      [bookingId],
    );
    const row = rows.rows[0];
    return row === undefined ? null : toSession(row);
  }

  /**
   * Oturumu **tarafı** için kilitler.
   *
   * Sahiplik sorgunun içindedir: oturum kimliğini bilen üçüncü bir kullanıcı ile
   * var olmayan oturum aynı sonucu (null → 404) alır; varlık bilgisi sızmaz
   * (ADR-0013 §3). `providerOnly`: telemetriyi yalnızca sağlayıcı gönderir.
   */
  async lockParticipantSession(
    client: PoolClient,
    sessionId: string,
    userId: string,
    providerOnly: boolean,
  ): Promise<SafetySession | null> {
    const rows = await client.query<SessionRow>(
      `${SELECT_SESSION}
        WHERE id = $1 AND (provider_id = $2 OR (NOT $3::boolean AND customer_id = $2))
        FOR UPDATE`,
      [sessionId, userId, providerOnly],
    );
    const row = rows.rows[0];
    return row === undefined ? null : toSession(row);
  }

  /** Rezervasyonun en güncel oturumu — yalnızca rezervasyonun tarafına. */
  async findLatestForBookingParticipant(
    bookingId: string,
    userId: string,
  ): Promise<SafetySession | null> {
    const rows = await this.uow.query<SessionRow>(
      `${SELECT_SESSION}
        WHERE booking_id = $1 AND (provider_id = $2 OR customer_id = $2)
        ORDER BY created_at DESC
        LIMIT 1`,
      [bookingId, userId],
    );
    const row = rows[0];
    return row === undefined ? null : toSession(row);
  }

  /** Operatör görünümü — sahiplik kapsaması yok; çağıran rol kontrolünü yapar. */
  async findById(sessionId: string): Promise<SafetySession | null> {
    const rows = await this.uow.query<SessionRow>(`${SELECT_SESSION} WHERE id = $1`, [sessionId]);
    const row = rows[0];
    return row === undefined ? null : toSession(row);
  }

  async listOpenForOperator(minRisk: RiskLevel, limit: number): Promise<SafetySession[]> {
    const rows = await this.uow.query<SessionRow>(
      `${SELECT_SESSION}
        WHERE status <> 'CLOSED' AND risk_level >= $1::safety_risk_level
        ORDER BY risk_level DESC, created_at DESC
        LIMIT $2`,
      [minRisk, limit],
    );
    return rows.map(toSession);
  }

  /**
   * Oturum durumunu değiştirir. Geçişin **geçerliliği** çağıranın sorumluluğundadır
   * (safety-session.state.ts); veritabanı geri gitmeyi ve kapalıdan çıkışı ayrıca reddeder.
   */
  async transitionSession(
    client: PoolClient,
    input: {
      sessionId: string;
      to: SafetySessionStatus;
      closureReason?: SafetyClosureReason;
    },
  ): Promise<void> {
    await client.query(
      `UPDATE safety_sessions
          SET status = $2::safety_session_status,
              monitoring_started_at = CASE WHEN $2::text = 'ARRIVAL_MONITORING'
                                           AND monitoring_started_at IS NULL
                                           THEN now() ELSE monitoring_started_at END,
              activated_at = CASE WHEN $2::text = 'ACTIVE' AND activated_at IS NULL
                                  THEN now() ELSE activated_at END,
              activation_geofence_state = CASE WHEN $2::text = 'ACTIVE'
                                               AND activation_geofence_state IS NULL
                                               THEN geofence_state
                                               ELSE activation_geofence_state END,
              -- Aktif hizmete geçişte ilk değerlendirme hemen planlanır; kapanışta
              -- izleyicinin tarama kümesinden çıkar.
              next_evaluation_at = CASE WHEN $2::text = 'CLOSED' THEN NULL
                                        WHEN $2::text IN ('ARRIVAL_MONITORING','ACTIVE')
                                        THEN now() ELSE next_evaluation_at END,
              closed_at = CASE WHEN $2::text = 'CLOSED' THEN now() ELSE closed_at END,
              closure_reason = CASE WHEN $2::text = 'CLOSED'
                                    THEN $3::safety_closure_reason ELSE closure_reason END
        WHERE id = $1`,
      [input.sessionId, input.to, input.closureReason ?? null],
    );
  }

  /**
   * Hizmet noktasına mesafeler — **PostGIS** ile, tek sorguda.
   *
   * Geofence kararı geography (sferoid) mesafesine dayanır. Örnekler tek tek
   * sorgulansaydı bir telemetri paketi (20 örnek) 20 gidiş-dönüş olurdu.
   */
  async distancesToService(
    client: PoolClient,
    sessionId: string,
    points: { latitude: number; longitude: number }[],
  ): Promise<number[]> {
    if (points.length === 0) {
      return [];
    }
    const result = await client.query<{ ordinality: string; distance: number }>(
      `SELECT p.ordinality::text AS ordinality,
              ST_Distance(
                s.service_location,
                ST_SetSRID(ST_MakePoint(p.lon, p.lat), 4326)::geography
              ) AS distance
         FROM safety_sessions s,
              unnest($2::float8[], $3::float8[]) WITH ORDINALITY AS p(lat, lon, ordinality)
        WHERE s.id = $1
        ORDER BY p.ordinality`,
      [sessionId, points.map((point) => point.latitude), points.map((point) => point.longitude)],
    );
    return result.rows.map((row) => Math.round(Number(row.distance)));
  }

  /** Kabul edilen örnekler tek INSERT ile yazılır (yazma çoğaltmasını sınırlar). */
  async insertLocationEvents(
    client: PoolClient,
    sessionId: string,
    rows: LocationEventRow[],
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await client.query(
      `INSERT INTO location_events
         (session_id, sequence_number, captured_at, latitude, longitude,
          accuracy_meters, speed_mps, heading_degrees, is_mock_location,
          distance_to_service_meters, geofence_state)
       SELECT $1, s.seq, s.captured, s.lat, s.lon, s.acc, s.speed, s.heading, s.mock,
              s.distance, s.state::geofence_state
         FROM unnest($2::bigint[], $3::timestamptz[], $4::float8[], $5::float8[],
                     $6::real[], $7::real[], $8::real[], $9::boolean[], $10::int[], $11::text[])
              AS s(seq, captured, lat, lon, acc, speed, heading, mock, distance, state)`,
      [
        sessionId,
        rows.map((row) => row.sequence),
        rows.map((row) => row.capturedAt),
        rows.map((row) => row.latitude),
        rows.map((row) => row.longitude),
        rows.map((row) => row.accuracyMeters),
        rows.map((row) => row.speedMps),
        rows.map((row) => row.headingDegrees),
        rows.map((row) => row.isMockLocation),
        rows.map((row) => row.distanceMeters),
        rows.map((row) => row.geofenceState),
      ],
    );
  }

  /**
   * Telemetri paketinin oturum üzerindeki etkisini **tek** UPDATE ile yazar.
   *
   * Çağıran oturumu `FOR UPDATE` ile kilitlemiş ve yeni durumu kilit altında
   * hesaplamıştır. `last_sequence` koşulu yine de burada durur: kilitsiz bir çağrı
   * yolu eklenirse replay koruması kendiliğinden çalışmaya devam etmeli.
   */
  async applyTelemetry(
    client: PoolClient,
    input: {
      sessionId: string;
      previousSequence: number;
      lastSequence: number;
      accepted: number;
      rejected: number;
      integrityRejections: number;
      mockLocations: number;
      lastAccepted: {
        capturedAt: Date;
        latitude: number;
        longitude: number;
        accuracyMeters: number;
        distanceMeters: number;
      } | null;
      consecutiveSpeedRejections: number;
      geofence: {
        state: GeofenceState;
        candidate: GeofenceState | null;
        candidateCount: number;
        transitioned: boolean;
      };
    },
  ): Promise<boolean> {
    const last = input.lastAccepted;
    const result = await client.query(
      `UPDATE safety_sessions
          SET last_sequence = $3::bigint,
              telemetry_count = telemetry_count + $4,
              rejected_count = rejected_count + $5,
              integrity_rejection_count = integrity_rejection_count + $6,
              mock_location_count = mock_location_count + $7,
              last_telemetry_at = CASE WHEN $8::boolean THEN now() ELSE last_telemetry_at END,
              last_captured_at = CASE WHEN $8::boolean THEN $9 ELSE last_captured_at END,
              last_latitude = CASE WHEN $8::boolean THEN $10 ELSE last_latitude END,
              last_longitude = CASE WHEN $8::boolean THEN $11 ELSE last_longitude END,
              last_accuracy_meters = CASE WHEN $8::boolean THEN $12 ELSE last_accuracy_meters END,
              last_distance_meters = CASE WHEN $8::boolean THEN $13 ELSE last_distance_meters END,
              consecutive_speed_rejections = $14,
              geofence_state = $15::geofence_state,
              geofence_state_since = CASE WHEN $18::boolean THEN now()
                                          ELSE geofence_state_since END,
              geofence_candidate_state = $16::geofence_state,
              geofence_candidate_count = $17
        WHERE id = $1
          AND last_sequence = $2::bigint
          AND status IN ('ARRIVAL_MONITORING','ACTIVE')`,
      [
        input.sessionId,
        input.previousSequence,
        input.lastSequence,
        input.accepted,
        input.rejected,
        input.integrityRejections,
        input.mockLocations,
        last !== null,
        last?.capturedAt ?? null,
        last?.latitude ?? null,
        last?.longitude ?? null,
        last?.accuracyMeters ?? null,
        last?.distanceMeters ?? null,
        input.consecutiveSpeedRejections,
        input.geofence.state,
        input.geofence.candidate,
        input.geofence.candidateCount,
        input.geofence.transitioned,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async insertEvent(
    client: PoolClient,
    input: {
      sessionId: string;
      bookingId: string;
      eventType: SafetyEventType;
      source: SafetyEventSource;
      riskLevel: RiskLevel;
      actorUserId?: string;
      ruleId?: string;
      ruleVersion?: string;
      modelVersion?: string;
      anomalyScore?: number;
      details?: Record<string, unknown>;
    },
  ): Promise<{ id: string; occurredAt: Date }> {
    const result = await client.query<{ id: string; occurred_at: Date }>(
      `INSERT INTO safety_events
         (session_id, booking_id, event_type, source, risk_level, actor_user_id,
          rule_id, rule_version, model_version, anomaly_score, details)
       VALUES ($1, $2, $3::safety_event_type, $4::safety_event_source,
               $5::safety_risk_level, $6, $7, $8, $9, $10, $11::jsonb)
       RETURNING id, occurred_at`,
      [
        input.sessionId,
        input.bookingId,
        input.eventType,
        input.source,
        input.riskLevel,
        input.actorUserId ?? null,
        input.ruleId ?? null,
        input.ruleVersion ?? null,
        input.modelVersion ?? null,
        input.anomalyScore ?? null,
        JSON.stringify(input.details ?? {}),
      ],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('güvenlik olayı kaydedilemedi');
    }
    return { id: row.id, occurredAt: row.occurred_at };
  }

  async insertAssessment(
    client: PoolClient,
    input: {
      sessionId: string;
      riskLevel: RiskLevel;
      computedRiskLevel: RiskLevel;
      previousRiskLevel: RiskLevel;
      determinedBy: string;
      rulesetVersion: string;
      aggregationVersion: string;
      triggeredRules: unknown[];
      anomalyModelVersion: string | null;
      anomalyScore: number | null;
      anomalyQuality: number | null;
      anomalyUnavailableReason: string | null;
      anomalyContributions: unknown[];
      routeProvider: string | null;
      unavailableSignals: string[];
      signals: Record<string, unknown>;
      latencyMs: number;
    },
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO safety_risk_assessments
         (session_id, risk_level, computed_risk_level, previous_risk_level, determined_by,
          ruleset_version, aggregation_version, triggered_rules,
          anomaly_model_version, anomaly_score, anomaly_quality, anomaly_available,
          anomaly_unavailable_reason, anomaly_contributions, route_provider,
          unavailable_signals, signals, latency_ms)
       VALUES ($1, $2::safety_risk_level, $3::safety_risk_level, $4::safety_risk_level, $5,
               $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14::jsonb, $15,
               $16::jsonb, $17::jsonb, $18)
       RETURNING id`,
      [
        input.sessionId,
        input.riskLevel,
        input.computedRiskLevel,
        input.previousRiskLevel,
        input.determinedBy,
        input.rulesetVersion,
        input.aggregationVersion,
        JSON.stringify(input.triggeredRules),
        input.anomalyModelVersion,
        input.anomalyScore,
        input.anomalyQuality,
        input.anomalyScore !== null,
        input.anomalyUnavailableReason,
        JSON.stringify(input.anomalyContributions),
        input.routeProvider,
        JSON.stringify(input.unavailableSignals),
        JSON.stringify(input.signals),
        input.latencyMs,
      ],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('risk değerlendirmesi kaydedilemedi');
    }
    return row.id;
  }

  /** Değerlendirme sonucunu oturuma yazar ve bir sonraki değerlendirmeyi planlar. */
  async applyEvaluation(
    client: PoolClient,
    input: {
      sessionId: string;
      riskLevel: RiskLevel;
      activeRules: string[];
      anomalyFlagged: boolean;
      nextEvaluationSeconds: number;
    },
  ): Promise<void> {
    await client.query(
      `UPDATE safety_sessions
          SET risk_level = $2::safety_risk_level,
              active_rules = $3::text[],
              anomaly_flagged = $4,
              last_evaluated_at = now(),
              next_evaluation_at = now() + make_interval(secs => $5::int)
        WHERE id = $1`,
      [
        input.sessionId,
        input.riskLevel,
        input.activeRules,
        input.anomalyFlagged,
        input.nextEvaluationSeconds,
      ],
    );
  }

  /**
   * Paniği oturuma işler; etkin bir panik varsa hiçbir şey yapmaz.
   *
   * Koşul UPDATE'in içindedir: eşzamanlı iki panik isteğinden yalnızca biri satırı
   * günceller. Operatörün çözdüğü bir acil durumdan sonra yeni panik kabul edilir.
   * Ham konumun saklama süresi kanıt süresine uzatılır: acil durum oturumunun izi
   * rutin retention ile silinmemeli (ADR-0008 §5; süre TODO(legal)).
   */
  async markPanic(
    client: PoolClient,
    sessionId: string,
    evidenceRetentionDays: number,
  ): Promise<{ raisedAt: Date; panicNumber: number } | null> {
    const result = await client.query<{ panic_raised_at: Date; panic_count: number }>(
      `UPDATE safety_sessions
          SET panic_raised_at = now(),
              panic_count = panic_count + 1,
              emergency_resolved_at = NULL,
              risk_level = 'EMERGENCY',
              retention_expires_at = GREATEST(
                retention_expires_at, now() + make_interval(days => $2::int)
              )
        WHERE id = $1
          AND (panic_raised_at IS NULL OR emergency_resolved_at IS NOT NULL)
       RETURNING panic_raised_at, panic_count`,
      [sessionId, evidenceRetentionDays],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : { raisedAt: row.panic_raised_at, panicNumber: Number(row.panic_count) };
  }

  /**
   * Operatörün risk kararı. `EMERGENCY`'den aşağı inmek etkin paniği **çözer**;
   * panik kaydı silinmez (append-only olay kalır), yalnızca etkinliği biter.
   */
  async overrideRisk(client: PoolClient, sessionId: string, level: RiskLevel): Promise<void> {
    await client.query(
      `UPDATE safety_sessions
          SET risk_level = $2::safety_risk_level,
              emergency_resolved_at = CASE
                WHEN $2::text <> 'EMERGENCY' AND panic_raised_at IS NOT NULL
                     AND emergency_resolved_at IS NULL THEN now()
                ELSE emergency_resolved_at END
        WHERE id = $1`,
      [sessionId, level],
    );
  }

  /**
   * Değerlendirmesi gelen oturumları **sahiplenir**.
   *
   * `FOR UPDATE SKIP LOCKED` + `next_evaluation_at`'i ileri atmak, çok instance'lı
   * çalışmada aynı oturumun iki kez değerlendirilmesini engeller (outbox publisher
   * ile aynı desen). Sahiplenme kısa bir transaction'dır; değerlendirmenin kendisi
   * (AI çağrısı dahil) bu transaction'ın **dışında** çalışır.
   */
  async claimDueSessions(limit: number, leaseSeconds: number): Promise<string[]> {
    const rows = await this.uow.query<{ id: string }>(
      `UPDATE safety_sessions
          SET next_evaluation_at = now() + make_interval(secs => $2::int)
        WHERE id IN (
          SELECT id FROM safety_sessions
           WHERE status IN ('ARRIVAL_MONITORING','ACTIVE')
             AND next_evaluation_at IS NOT NULL
             AND next_evaluation_at <= now()
           ORDER BY next_evaluation_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
       RETURNING id`,
      [limit, leaseSeconds],
    );
    return rows.map((row) => row.id);
  }

  /** İz özeti için son penceredeki örnekler (sınırlı sayıda, yalnızca gereken alanlar). */
  async recentTrace(
    sessionId: string,
    windowSeconds: number,
    limit: number,
  ): Promise<TraceSample[]> {
    const rows = await this.uow.query<{
      captured_at: Date;
      latitude: number;
      longitude: number;
      accuracy_meters: number;
      distance_to_service_meters: number;
    }>(
      `SELECT captured_at, latitude, longitude, accuracy_meters, distance_to_service_meters
         FROM location_events
        WHERE session_id = $1
          AND server_received_at >= now() - make_interval(secs => $2::int)
        ORDER BY server_received_at DESC
        LIMIT $3`,
      [sessionId, windowSeconds, limit],
    );

    return rows.map((row) => ({
      capturedAt: row.captured_at,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      accuracyMeters: Number(row.accuracy_meters),
      distanceToServiceMeters: Number(row.distance_to_service_meters),
    }));
  }

  /** Operatör: ham iz (erişim audit'lenir, çağıranın sorumluluğu). */
  async listLocations(
    sessionId: string,
    limit: number,
  ): Promise<
    {
      sequence: number;
      capturedAt: Date;
      receivedAt: Date;
      latitude: number;
      longitude: number;
      accuracyMeters: number;
      isMockLocation: boolean;
      distanceMeters: number;
      geofenceState: GeofenceState;
    }[]
  > {
    const rows = await this.uow.query<{
      sequence_number: string;
      captured_at: Date;
      server_received_at: Date;
      latitude: number;
      longitude: number;
      accuracy_meters: number;
      is_mock_location: boolean;
      distance_to_service_meters: number;
      geofence_state: GeofenceState;
    }>(
      `SELECT sequence_number::text, captured_at, server_received_at, latitude, longitude,
              accuracy_meters, is_mock_location, distance_to_service_meters, geofence_state
         FROM location_events
        WHERE session_id = $1
        ORDER BY server_received_at DESC, sequence_number DESC
        LIMIT $2`,
      [sessionId, limit],
    );
    return rows.map((row) => ({
      sequence: Number(row.sequence_number),
      capturedAt: row.captured_at,
      receivedAt: row.server_received_at,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      accuracyMeters: Number(row.accuracy_meters),
      isMockLocation: row.is_mock_location,
      distanceMeters: Number(row.distance_to_service_meters),
      geofenceState: row.geofence_state,
    }));
  }

  async listEvents(sessionId: string, limit: number): Promise<SafetyEventRecord[]> {
    const rows = await this.uow.query<{
      id: string;
      event_type: SafetyEventType;
      source: SafetyEventSource;
      risk_level: RiskLevel;
      rule_id: string | null;
      rule_version: string | null;
      model_version: string | null;
      anomaly_score: string | null;
      occurred_at: Date;
      details: Record<string, unknown>;
    }>(
      `SELECT id, event_type, source, risk_level, rule_id, rule_version, model_version,
              anomaly_score::text, occurred_at, details
         FROM safety_events
        WHERE session_id = $1
        ORDER BY seq DESC
        LIMIT $2`,
      [sessionId, limit],
    );

    return rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      source: row.source,
      riskLevel: row.risk_level,
      ruleId: row.rule_id,
      ruleVersion: row.rule_version,
      modelVersion: row.model_version,
      anomalyScore: row.anomaly_score === null ? null : Number(row.anomaly_score),
      occurredAt: row.occurred_at,
      details: row.details,
    }));
  }

  async listAssessments(sessionId: string, limit: number): Promise<AssessmentRecord[]> {
    const rows = await this.uow.query<{
      id: string;
      risk_level: RiskLevel;
      computed_risk_level: RiskLevel;
      previous_risk_level: RiskLevel;
      determined_by: string;
      ruleset_version: string;
      aggregation_version: string;
      triggered_rules: unknown[];
      anomaly_model_version: string | null;
      anomaly_score: string | null;
      anomaly_quality: string | null;
      anomaly_available: boolean;
      anomaly_unavailable_reason: string | null;
      anomaly_contributions: unknown[];
      route_provider: string | null;
      unavailable_signals: string[];
      signals: Record<string, unknown>;
      evaluated_at: Date;
      latency_ms: number;
    }>(
      `SELECT id, risk_level, computed_risk_level, previous_risk_level, determined_by,
              ruleset_version, aggregation_version, triggered_rules,
              anomaly_model_version, anomaly_score::text, anomaly_quality::text,
              anomaly_available, anomaly_unavailable_reason, anomaly_contributions,
              route_provider, unavailable_signals, signals, evaluated_at, latency_ms
         FROM safety_risk_assessments
        WHERE session_id = $1
        ORDER BY evaluated_at DESC, id
        LIMIT $2`,
      [sessionId, limit],
    );

    return rows.map((row) => ({
      id: row.id,
      riskLevel: row.risk_level,
      computedRiskLevel: row.computed_risk_level,
      previousRiskLevel: row.previous_risk_level,
      determinedBy: row.determined_by,
      rulesetVersion: row.ruleset_version,
      aggregationVersion: row.aggregation_version,
      triggeredRules: row.triggered_rules,
      anomalyModelVersion: row.anomaly_model_version,
      anomalyScore: row.anomaly_score === null ? null : Number(row.anomaly_score),
      anomalyQuality: row.anomaly_quality === null ? null : Number(row.anomaly_quality),
      anomalyAvailable: row.anomaly_available,
      anomalyUnavailableReason: row.anomaly_unavailable_reason,
      anomalyContributions: row.anomaly_contributions,
      routeProvider: row.route_provider,
      unavailableSignals: row.unavailable_signals,
      signals: row.signals,
      evaluatedAt: row.evaluated_at,
      latencyMs: Number(row.latency_ms),
    }));
  }

  /**
   * Süresi dolmuş açık oturumlar.
   *
   * `HIGH_RISK`/`EMERGENCY` oturumlar **kendiliğinden kapanmaz**: operatörün
   * bakmadığı bir alarmı zamanlayıcıyla kapatmak, alarmı sessizce yok etmek olurdu.
   */
  async findExpiredOpenSessions(graceHours: number, limit: number): Promise<string[]> {
    const rows = await this.uow.query<{ id: string }>(
      `SELECT id FROM safety_sessions
        WHERE status <> 'CLOSED'
          AND risk_level IN ('NORMAL','WARNING')
          AND scheduled_end + make_interval(hours => $1::int) < now()
        ORDER BY scheduled_end
        LIMIT $2`,
      [graceHours, limit],
    );
    return rows.map((row) => row.id);
  }

  /**
   * Retention: saklama süresi dolmuş **kapalı** oturumların ham konumunu siler.
   *
   * Silinen şey ham yüksek frekanslı örneklerdir; güvenlik olayları ve risk
   * değerlendirmeleri kalır (kanıttır, append-only'dir ve koordinat taşımaz).
   * Oturum özeti (sayaçlar) araştırma için kalır; hizmet noktası ~1 km'ye
   * yuvarlanır ve son konum silinir. "Ne oldu" korunur, "saniye saniye neredeydi"
   * düşer — veri minimizasyonunun karşılığı (ADR-0008 §5).
   *
   * Tek transaction'da ve sınırlı sayıda oturum üzerinde çalışır: silme yarıda
   * kalırsa oturum "temizlendi" işaretlenmez ve sonraki turda tekrar denenir.
   */
  async purgeExpiredLocations(
    client: PoolClient,
    limit: number,
  ): Promise<{ sessionIds: string[]; deletedRows: number }> {
    const sessions = await client.query<{ id: string }>(
      `SELECT id FROM safety_sessions
        WHERE location_purged_at IS NULL
          AND status = 'CLOSED'
          AND retention_expires_at < now()
        ORDER BY retention_expires_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    const ids = sessions.rows.map((row) => row.id);
    if (ids.length === 0) {
      return { sessionIds: [], deletedRows: 0 };
    }

    const deleted = await client.query(`DELETE FROM location_events WHERE session_id = ANY($1)`, [
      ids,
    ]);

    await client.query(
      `UPDATE safety_sessions
          SET last_latitude = NULL,
              last_longitude = NULL,
              last_accuracy_meters = NULL,
              service_location = ST_SnapToGrid(service_location::geometry, 0.01)::geography,
              location_purged_at = now()
        WHERE id = ANY($1)`,
      [ids],
    );

    return { sessionIds: ids, deletedRows: deleted.rowCount ?? 0 };
  }

  /** Aylık partition'ı hazırlar (yoksa oluşturur). DEFAULT'ta veri varsa null. */
  async ensureLocationPartition(target: Date): Promise<string | null> {
    const rows = await this.uow.query<{ name: string | null }>(
      `SELECT safety_ensure_location_partition($1) AS name`,
      [target],
    );
    return rows[0]?.name ?? null;
  }
}
