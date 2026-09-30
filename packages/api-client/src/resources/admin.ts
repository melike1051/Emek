import { pathSegment, type ApiClient, type QueryValue } from '../client';
import type {
  Booking,
  BookingStatus,
  Dispute,
  DisputeStatus,
  Payment,
  PaymentStatus,
} from './bookings';
import type { ProviderProfile, ProviderState } from './profiles';

/**
 * Operasyon (ADMIN/SUPPORT) uçları — `apps/admin` tüketir (ADR-0024 §1).
 * Okuma uçları iki role açık, yazma uçları yalnız `ADMIN` (docs/security/rbac-matrix.md).
 * Yazma çağrıları çağıranın `Idempotency-Key`'ini taşır: aynı operatör eyleminin yeniden
 * denemesi (ağ hatası) komutu ikinci kez işletmez — özellikle release/refund.
 */

/** Kaynak: services/api/src/common/pagination/cursor.ts — opak keyset cursor. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PageQuery {
  cursor?: string;
  limit?: number;
}

// --- Kimlik kurtarma (identity.controller.ts, RecoveryRequestResponseDto) ---

export type RecoveryStatus = 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';

export interface RecoveryRequest {
  id: string;
  requesterUserId: string;
  targetUserId: string;
  status: RecoveryStatus;
  assuranceLevel: string;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
}

// --- Uyuşmazlık kararı (ResolveDisputeDto) ---

export type DisputeResolutionStatus = 'RESOLVED_CUSTOMER' | 'RESOLVED_PROVIDER' | 'WITHDRAWN';

export interface ResolveDisputeInput {
  status: DisputeResolutionStatus;
  /** ≤2000 */
  resolution: string;
  /** Minor unit string; yalnız karar kaydıdır, para hareketi ayrı `refund` çağrısıdır. */
  refundAmountMinor?: string;
}

/** Kaynak: RefundPaymentDto — `amountMinor` yoksa kalan tutarın tamamı; reason ≤160. */
export interface RefundInput {
  amountMinor?: string;
  reason: string;
}

// --- Safety operatör (safety/dto/safety.dto.ts) ---

/** Kaynak: services/api/src/safety/safety.constants.ts (RISK_LEVELS). */
export type RiskLevel = 'NORMAL' | 'WARNING' | 'HIGH_RISK' | 'EMERGENCY';

export type SafetyEventType =
  | 'SESSION_STARTED'
  | 'ARRIVAL_MONITORING_STARTED'
  | 'SESSION_ACTIVATED'
  | 'GEOFENCE_ENTERED'
  | 'GEOFENCE_EXITED'
  | 'TELEMETRY_REJECTED'
  | 'TELEMETRY_REANCHORED'
  | 'RULE_TRIGGERED'
  | 'ANOMALY_FLAGGED'
  | 'RISK_ESCALATED'
  | 'RISK_DEESCALATED'
  | 'RISK_OVERRIDDEN'
  | 'PANIC_RAISED'
  | 'SESSION_CLOSED';

/** Kaynak: OperatorSessionSummaryDto — koordinat içermez. */
export interface OperatorSession {
  sessionId: string;
  bookingId: string;
  providerId: string;
  customerId: string;
  status: string;
  riskLevel: RiskLevel;
  geofenceState: string;
  lastDistanceMeters: number | null;
  lastTelemetryAt: string | null;
  telemetryCount: number;
  rejectedCount: number;
  integrityRejectionCount: number;
  mockLocationCount: number;
  activeRules: string[];
  anomalyFlagged: boolean;
  emergencyActive: boolean;
  panicRaisedAt: string | null;
  scheduledStart: string;
  scheduledEnd: string;
  closedAt: string | null;
  closureReason: string | null;
  retentionExpiresAt: string;
  locationPurgedAt: string | null;
}

/** Kaynak: safety.repository.ts AssessmentRecord (tarih ISO'ya çevrilmiş). */
export interface SafetyAssessment {
  id: string;
  riskLevel: RiskLevel;
  computedRiskLevel: RiskLevel;
  previousRiskLevel: RiskLevel;
  determinedBy: string;
  rulesetVersion: string;
  anomalyModelVersion: string | null;
  anomalyScore: number | null;
  anomalyAvailable: boolean;
  unavailableSignals: string[];
  evaluatedAt: string;
  latencyMs: number;
}

/** Kaynak: safety.repository.ts SafetyEventRecord. */
export interface SafetyEvent {
  id: string;
  eventType: SafetyEventType;
  source: string;
  riskLevel: RiskLevel;
  ruleId: string | null;
  ruleVersion: string | null;
  modelVersion: string | null;
  anomalyScore: number | null;
  occurredAt: string;
  details: Record<string, unknown>;
}

/** Kaynak: OperatorSessionDetailDto. */
export interface OperatorSessionDetail extends OperatorSession {
  assessments: SafetyAssessment[];
  events: SafetyEvent[];
}

/** Kaynak: OperatorEventResponseDto. */
export interface OperatorEvent extends SafetyEvent {
  sessionId: string;
  bookingId: string;
}

/** Kaynak: OverrideRiskDto — reason 5..500, floorMinutes 5..1440 (varsayılan 120). */
export interface OverrideRiskInput {
  riskLevel: RiskLevel;
  reason: string;
  floorMinutes?: number;
}

/** Kaynak: EvaluationResponseDto. */
export interface EvaluationResult {
  status: string;
  sessionId: string;
  previousRiskLevel: string | null;
  riskLevel: string | null;
  computedRiskLevel: string | null;
  findings: { ruleId: string; ruleVersion: string; severity: string }[];
  anomaly: {
    status: string;
    reason: string | null;
    score: number | null;
    modelVersion: string | null;
  };
  unavailableSignals: string[];
  assessmentId: string | null;
  latencyMs: number;
}

/** Kaynak: OperatorLocationsResponseDto — ham iz; **önbelleğe alınmaz, saklanmaz**. */
export interface OperatorLocations {
  sessionId: string;
  locationPurgedAt: string | null;
  locations: {
    sequence: number;
    capturedAt: string;
    receivedAt: string;
    latitude: number;
    longitude: number;
    accuracyMeters: number;
    isMockLocation: boolean;
    distanceMeters: number;
    geofenceState: string;
  }[];
}

/** Kaynak: OperatorLocationQueryDto — reason 5..500 zorunlu (audit), limit 1..500. */
export interface LocationAccessInput {
  reason: string;
  breakGlass: boolean;
  limit?: number;
}

// --- Ops (ops/dto/ops.dto.ts) ---

export interface OpsHealth {
  outbox: { pendingCount: number; failedCount: number; oldestPendingAgeMs: number | null };
  deadLetter: {
    unresolvedCount: number;
    unresolvedByConsumer: { consumer: string; count: number }[];
  };
  notificationJobs: { status: string; count: number }[];
}

/** Kaynak: DeadLetterResponseDto — payload'da PII yok (event-catalog §1). */
export interface DeadLetter {
  id: string;
  eventId: string;
  eventType: string;
  eventVersion: number;
  consumer: string;
  payload: Record<string, unknown>;
  attemptCount: number;
  failureClassification: string;
  failureReason: string;
  firstFailureAt: string;
  lastFailureAt: string;
  resolvedAt: string | null;
  createdAt: string;
}

export type NotificationJobStatus = 'PENDING' | 'SENT' | 'FAILED';

export interface NotificationJob {
  id: string;
  eventId: string;
  eventType: string;
  channel: string;
  recipientUserId: string;
  templateKey: string;
  status: NotificationJobStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

/** Kaynak: AuditChainStatusResponseDto — `BROKEN` bir bulgudur, HTTP hatası değil. */
export interface AuditChainStatus {
  status: 'OK' | 'BROKEN';
  rowsVerified: number;
  verifiedThroughId: string | null;
  brokenAtId: string | null;
  exportedStorageKey: string | null;
}

/** Kaynak: RetentionSweepResponseDto. */
export interface RetentionSweepResult {
  anonymizedUsers: number;
  processedEvents: number;
  deadLetterEvents: number;
  verificationAttempts: number;
  analyticsEvents: number;
}

// --- Analitik / mutabakat (analytics/dto/analytics.dto.ts) ---

export interface AnalyticsExportStatus {
  unexportedCount: number;
  oldestUnexportedAgeMs: number | null;
  lastExportedAt: string | null;
}

export type DiscrepancyType =
  'STUCK_PENDING_COMMAND' | 'AUTHORIZATION_EXPIRED_UNHANDLED' | 'RELEASE_PENDING_STALLED';

export interface ReconciliationDiscrepancy {
  id: string;
  runId: string;
  paymentId: string;
  discrepancyType: DiscrepancyType;
  details: Record<string, unknown>;
  detectedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface ReconciliationRun {
  runId: string;
  checkedCount: number;
  discrepancyCount: number;
  newDiscrepancyCount: number;
}

/** Kaynak: MatchingStatsResponseDto — ham skor bileşeni yok (T-19). */
export interface MatchingStats {
  sinceDays: number;
  totalRuns: number;
  degradedRuns: number;
  degradedRate: number;
  byStrategy: { strategy: string; count: number }[];
  byDegradedReason: { reason: string; count: number }[];
  avgCandidateCount: number;
  avgRetrievalMs: number;
  avgDecisionMs: number;
}

/** Query-string boolean'ları backend'de `'true'|'false'` metnidir (ops.dto.ts notu). */
const bool = (value: boolean | undefined): QueryValue =>
  value === undefined ? undefined : String(value);

export function adminApi(client: ApiClient) {
  const id = pathSegment;
  const page = <T>(path: string, query: Record<string, QueryValue>) =>
    client.get<Page<T>>(path, { query });

  return {
    providers: {
      queue: (q: PageQuery & { state?: ProviderState }) =>
        page<ProviderProfile>('/providers/queue', { ...q }),
      approve: (userId: string, key: string) =>
        client.post<ProviderProfile>(
          `/providers/${id(userId)}/approve`,
          {},
          { idempotencyKey: key },
        ),
      reject: (userId: string, reason: string, key: string) =>
        client.post<ProviderProfile>(
          `/providers/${id(userId)}/reject`,
          { reason },
          { idempotencyKey: key },
        ),
      suspend: (userId: string, reason: string, key: string) =>
        client.post<ProviderProfile>(
          `/providers/${id(userId)}/suspend`,
          { reason },
          { idempotencyKey: key },
        ),
      reinstate: (userId: string, key: string) =>
        client.post<ProviderProfile>(
          `/providers/${id(userId)}/reinstate`,
          {},
          { idempotencyKey: key },
        ),
    },

    recovery: {
      queue: (q: PageQuery & { status?: RecoveryStatus }) =>
        page<RecoveryRequest>('/verification/recovery-requests', { ...q }),
      /** R-36: talebin tarafı olan operatör onaylayamaz — backend reddeder, mesajı gösterilir. */
      approve: (requestId: string, reason: string | undefined, key: string) =>
        client.post<{ status: 'APPROVED'; recoveredUserId?: string }>(
          `/verification/recovery-requests/${id(requestId)}/approve`,
          reason ? { reason } : {},
          { idempotencyKey: key },
        ),
      reject: (requestId: string, reason: string, key: string) =>
        client.post<{ status: 'REJECTED' }>(
          `/verification/recovery-requests/${id(requestId)}/reject`,
          { reason },
          { idempotencyKey: key },
        ),
    },

    bookings: {
      list: (q: PageQuery & { status?: BookingStatus; customerId?: string; providerId?: string }) =>
        page<Booking>('/bookings/admin', { ...q }),
    },

    payments: {
      list: (q: PageQuery & { status?: PaymentStatus; bookingId?: string }) =>
        page<Payment>('/payments/admin', { ...q }),
      release: (paymentId: string, key: string) =>
        client.post<Payment>(`/payments/${id(paymentId)}/release`, {}, { idempotencyKey: key }),
      refund: (paymentId: string, input: RefundInput, key: string) =>
        client.post<Payment>(`/payments/${id(paymentId)}/refund`, input, { idempotencyKey: key }),
      reauthorize: (paymentId: string, key: string) =>
        client.post<Payment>(
          `/payments/${id(paymentId)}/reauthorize`,
          {},
          {
            idempotencyKey: key,
          },
        ),
    },

    disputes: {
      list: (q: PageQuery & { status?: DisputeStatus }) =>
        page<Dispute>('/disputes/admin', { ...q }),
      resolve: (disputeId: string, input: ResolveDisputeInput, key: string) =>
        client.post<Dispute>(`/disputes/${id(disputeId)}/resolve`, input, { idempotencyKey: key }),
    },

    safety: {
      /** Açık oturumlar; sayfalama yok (backend üst sınırı sabit). */
      sessions: (minRisk?: RiskLevel) =>
        client.get<OperatorSession[]>('/safety/operator/sessions', { query: { minRisk } }),
      session: (sessionId: string) =>
        client.get<OperatorSessionDetail>(`/safety/operator/sessions/${id(sessionId)}`),
      events: (q: PageQuery & { minRisk?: RiskLevel; type?: SafetyEventType }) =>
        page<OperatorEvent>('/safety/operator/events', { ...q }),
      /** Ham konum: yalnız ADMIN, gerekçe zorunlu, her okuma audit'li. */
      locations: (sessionId: string, input: LocationAccessInput) =>
        client.get<OperatorLocations>(`/safety/operator/sessions/${id(sessionId)}/locations`, {
          query: { reason: input.reason, breakGlass: bool(input.breakGlass), limit: input.limit },
        }),
      overrideRisk: (sessionId: string, input: OverrideRiskInput, key: string) =>
        client.post<OperatorSession>(`/safety/operator/sessions/${id(sessionId)}/risk`, input, {
          idempotencyKey: key,
        }),
      close: (sessionId: string, reason: string, key: string) =>
        client.post<OperatorSession>(
          `/safety/operator/sessions/${id(sessionId)}/close`,
          { reason },
          { idempotencyKey: key },
        ),
      evaluate: (sessionId: string) =>
        client.post<EvaluationResult>(`/safety/operator/sessions/${id(sessionId)}/evaluate`),
    },

    ops: {
      health: () => client.get<OpsHealth>('/ops/health'),
      deadLetters: (q: PageQuery & { consumer?: string; resolved?: boolean }) =>
        page<DeadLetter>('/ops/dead-letter', { ...q, resolved: bool(q.resolved) }),
      resolveDeadLetter: (deadLetterId: string, key: string) =>
        client.post<{ resolved: true }>(
          `/ops/dead-letter/${id(deadLetterId)}/resolve`,
          {},
          {
            idempotencyKey: key,
          },
        ),
      notificationJobs: (q: PageQuery & { status?: NotificationJobStatus }) =>
        page<NotificationJob>('/ops/notification-jobs', { ...q }),
      retryNotificationJob: (jobId: string, key: string) =>
        client.post<{ retried: true }>(
          `/ops/notification-jobs/${id(jobId)}/retry`,
          {},
          {
            idempotencyKey: key,
          },
        ),
      auditChain: () => client.get<AuditChainStatus>('/ops/audit-chain'),
      verifyAuditChain: () => client.post<AuditChainStatus>('/ops/audit-chain/verify'),
      /** **Veri siler** (ADR-0013 §4). */
      retentionSweep: (key: string) =>
        client.post<RetentionSweepResult>('/ops/retention/sweep', {}, { idempotencyKey: key }),
    },

    analytics: {
      exportStatus: () => client.get<AnalyticsExportStatus>('/analytics/export/status'),
      matchingStats: (sinceDays?: number) =>
        client.get<MatchingStats>('/matching/admin/stats', { query: { sinceDays } }),
      discrepancies: (q: PageQuery & { resolved?: boolean; discrepancyType?: DiscrepancyType }) =>
        page<ReconciliationDiscrepancy>('/analytics/reconciliation', {
          ...q,
          resolved: bool(q.resolved),
        }),
      runReconciliation: (key: string) =>
        client.post<ReconciliationRun>(
          '/analytics/reconciliation/run',
          {},
          { idempotencyKey: key },
        ),
      resolveDiscrepancy: (discrepancyId: string, key: string) =>
        client.post<{ resolved: true }>(
          `/analytics/reconciliation/${id(discrepancyId)}/resolve`,
          {},
          { idempotencyKey: key },
        ),
    },
  };
}

export type AdminApi = ReturnType<typeof adminApi>;
