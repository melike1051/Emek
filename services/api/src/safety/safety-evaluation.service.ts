import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditAction, AuditService } from '../common/audit/audit.service';
import { AppConfigService } from '../common/config/app-config.service';
import { UnitOfWork } from '../common/database/unit-of-work';
import { EventType, OutboxService } from '../common/outbox/outbox.service';
import { buildAnomalyFeatures } from './anomaly-features';
import { ANOMALY_CLIENT, type AnomalyClient, type AnomalyOutcome } from './anomaly.port';
import {
  RISK_AGGREGATION_VERSION,
  aggregateRisk,
  resolveAppliedLevel,
  type RiskOutcome,
} from './rules/risk-aggregation';
import {
  DEFAULT_RULE_THRESHOLDS,
  SAFETY_RULESET_VERSION,
  evaluateRules,
} from './rules/safety-rules';
import {
  buildSignals,
  markUnavailable,
  summarizeTrace,
  withRoute,
  type RuleFinding,
  type SafetySignals,
} from './rules/safety-signals';
import { acceptsTelemetry, riskRank, type RiskLevel } from './safety.constants';
import { SafetyMetrics } from './safety-metrics';
import { SafetyRepository, isPanicActive } from './safety.repository';

/** İz özeti için okunan pencere ve örnek sınırı. */
const TRACE_WINDOW_SECONDS = 60 * 60;
const TRACE_SAMPLE_LIMIT = 240;
/** İzleyicinin tek turda değerlendirdiği azami oturum. */
const EVALUATION_BATCH_LIMIT = 25;

export type EvaluationStatus = 'EVALUATED' | 'DISCARDED_SESSION_NOT_ACTIVE' | 'NOT_FOUND';

export interface EvaluationResult {
  status: EvaluationStatus;
  sessionId: string;
  previousRiskLevel: RiskLevel | null;
  riskLevel: RiskLevel | null;
  computedRiskLevel: RiskLevel | null;
  findings: RuleFinding[];
  anomaly: AnomalyOutcome | null;
  unavailableSignals: string[];
  assessmentId: string | null;
  latencyMs: number;
}

/**
 * Hibrit güvenlik değerlendirmesi (ADR-0008 §2, ADR-0019 §5-§7).
 *
 *     doğrulanmış telemetri/sinyaller → deterministik kurallar
 *       → anomali modeli (destekleyici) → risk toplama → güvenlik kararı
 *
 * Asla: ham GPS → LLM → acil durum.
 *
 * Faz 7 dersi burada da geçerlidir: **OKU → KARAR VER → YAZ**.
 *
 * 1. **Okuma** transaction'sız, kısa sorgulardır.
 * 2. **Karar** AI servisine gider (anomali skoru + rota tahmini) ve bu çağrı hiçbir
 *    veritabanı bağlantısı ya da kilidi tutmadan yapılır. Yavaşlayan bir AI servisi
 *    havuzu tüketip panik yolunu da durduramaz.
 * 3. **Yazma** kısa bir transaction'dır ve oturumu **taze** okur: arada oturum
 *    kapandıysa sonuç atılır; arada panik geldiyse `EMERGENCY` korunur.
 *
 * AI erişilemezse değerlendirme **yine yapılır**: kurallar modelden bağımsızdır,
 * eksik sinyal açıkça kaydedilir ve hiçbir şey "normal" varsayılmaz.
 */
@Injectable()
export class SafetyEvaluationService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repository: SafetyRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly config: AppConfigService,
    private readonly metrics: SafetyMetrics,
    @Inject(ANOMALY_CLIENT) private readonly anomaly: AnomalyClient,
  ) {}

  /** Değerlendirmesi gelen oturumları sahiplenip sırayla değerlendirir. */
  async evaluateDue(): Promise<EvaluationResult[]> {
    const ids = await this.repository.claimDueSessions(
      EVALUATION_BATCH_LIMIT,
      this.config.env.SAFETY_EVALUATION_INTERVAL_SECONDS,
    );
    const results: EvaluationResult[] = [];
    for (const id of ids) {
      results.push(await this.evaluate(id));
    }
    return results;
  }

  async evaluate(sessionId: string, now: Date = new Date()): Promise<EvaluationResult> {
    const started = Date.now();

    // --- 1. Okuma ---
    const session = await this.repository.findById(sessionId);
    if (session === null) {
      return emptyResult('NOT_FOUND', sessionId, started);
    }
    if (!acceptsTelemetry(session.status)) {
      // PRE_SERVICE ve CLOSED değerlendirilmez: telemetri yoksa sinyal de yoktur;
      // kapalı oturum için risk hesaplamak anlamsızdır.
      return emptyResult('DISCARDED_SESSION_NOT_ACTIVE', sessionId, started);
    }

    const trace = await this.repository.recentTrace(
      session.id,
      TRACE_WINDOW_SECONDS,
      TRACE_SAMPLE_LIMIT,
    );
    let signals = buildSignals(session, summarizeTrace(trace, session.geofenceRadiusMeters), now);

    // --- 2. Karar (transaction dışında) ---
    const anomalyStarted = Date.now();
    const anomaly = await this.anomaly.assess(buildAnomalyFeatures(session, signals));
    const anomalyMs = Date.now() - anomalyStarted;

    if (anomaly.status === 'ASSESSED') {
      signals = withRoute(
        signals,
        anomaly.assessment.route === null
          ? null
          : {
              etaSeconds: anomaly.assessment.route.etaSeconds,
              provider: anomaly.assessment.route.provider,
            },
      );
      if (session.status === 'ARRIVAL_MONITORING' && anomaly.assessment.route === null) {
        this.metrics.failure('safety.route.unavailable', { sessionId: session.id });
      }
    } else {
      markUnavailable(signals, 'anomaly');
      this.metrics.failure('safety.anomaly.unavailable', {
        sessionId: session.id,
        reason: anomaly.status === 'UNAVAILABLE' ? anomaly.reason : null,
        latencyMs: anomalyMs,
      });
    }

    const findings = evaluateRules(signals, DEFAULT_RULE_THRESHOLDS);
    const risk = aggregateRisk({
      findings,
      anomaly:
        anomaly.status === 'ASSESSED'
          ? { score: anomaly.assessment.anomalyScore, quality: anomaly.assessment.quality }
          : null,
      panicRaised: isPanicActive(session),
    });

    // --- 3. Yazma (taze doğrulama ile) ---
    const written = await this.uow.withTransaction((client) =>
      this.persist(client, { sessionId, signals, findings, risk, anomaly, started }),
    );

    if (written === null) {
      this.metrics.record('safety.evaluation.discarded', { sessionId });
      return {
        ...emptyResult('DISCARDED_SESSION_NOT_ACTIVE', sessionId, started),
        findings,
        anomaly,
        unavailableSignals: signals.unavailable,
      };
    }

    const latencyMs = Date.now() - started;
    this.metrics.record('safety.evaluation.completed', {
      sessionId,
      riskLevel: written.applied,
      computedRiskLevel: risk.level,
      findings: findings.length,
      anomalyAvailable: anomaly.status === 'ASSESSED',
      latencyMs,
      anomalyLatencyMs: anomalyMs,
    });
    if (written.applied !== written.previous) {
      this.metrics.record('safety.risk.changed', {
        sessionId,
        from: written.previous,
        to: written.applied,
      });
    }

    return {
      status: 'EVALUATED',
      sessionId,
      previousRiskLevel: written.previous,
      riskLevel: written.applied,
      computedRiskLevel: risk.level,
      findings,
      anomaly,
      unavailableSignals: signals.unavailable,
      assessmentId: written.assessmentId,
      latencyMs,
    };
  }

  private async persist(
    client: PoolClient,
    input: {
      sessionId: string;
      signals: SafetySignals;
      findings: RuleFinding[];
      risk: RiskOutcome;
      anomaly: AnomalyOutcome;
      started: number;
    },
  ): Promise<{ previous: RiskLevel; applied: RiskLevel; assessmentId: string } | null> {
    // Taze okuma: karar verilirken oturum kapanmış olabilir (check-out ile yarış)
    // ya da panik gelmiş olabilir (seviye EMERGENCY'ye çıkmış).
    const session = await this.repository.lockSession(client, input.sessionId);
    if (session === null || !acceptsTelemetry(session.status)) {
      return null;
    }

    const { signals, findings, risk, anomaly } = input;
    const previous = session.riskLevel;
    const panicActive = isPanicActive(session);
    const computed = panicActive ? 'EMERGENCY' : risk.level;
    const applied = resolveAppliedLevel(previous, computed);
    const assessed = anomaly.status === 'ASSESSED' ? anomaly.assessment : null;

    const assessmentId = await this.repository.insertAssessment(client, {
      sessionId: session.id,
      riskLevel: applied,
      computedRiskLevel: computed,
      previousRiskLevel: previous,
      determinedBy: panicActive ? 'USER' : risk.determinedBy,
      rulesetVersion: SAFETY_RULESET_VERSION,
      aggregationVersion: RISK_AGGREGATION_VERSION,
      triggeredRules: findings,
      anomalyModelVersion: assessed?.modelVersion ?? null,
      anomalyScore: assessed?.anomalyScore ?? null,
      anomalyQuality: assessed?.quality ?? null,
      anomalyUnavailableReason: anomaly.status === 'UNAVAILABLE' ? anomaly.reason : null,
      anomalyContributions: assessed?.contributions ?? [],
      routeProvider: signals.routeProvider,
      unavailableSignals: signals.unavailable,
      signals: serializeSignals(signals, risk),
      latencyMs: Date.now() - input.started,
    });

    // Olaylar yalnızca **değişimde**: önceki değerlendirmede de tetiklenmiş bir
    // kuralı her turda yeniden yazmak operatör görünümünü gürültüye boğardı.
    const activeRules = findings.map((finding) => finding.ruleId);
    for (const finding of findings) {
      if (session.activeRules.includes(finding.ruleId)) {
        continue;
      }
      await this.repository.insertEvent(client, {
        sessionId: session.id,
        bookingId: session.bookingId,
        eventType: 'RULE_TRIGGERED',
        source: 'RULE',
        riskLevel: finding.severity,
        ruleId: finding.ruleId,
        ruleVersion: finding.ruleVersion,
        details: { evidence: finding.evidence, assessmentId },
      });
    }

    if (assessed !== null && risk.anomalyFlagged && !session.anomalyFlagged) {
      await this.repository.insertEvent(client, {
        sessionId: session.id,
        bookingId: session.bookingId,
        eventType: 'ANOMALY_FLAGGED',
        source: 'ML',
        // Model tek başına WARNING'i geçemez; olay da bunu yansıtır.
        riskLevel: 'WARNING',
        modelVersion: assessed.modelVersion,
        anomalyScore: assessed.anomalyScore,
        details: {
          quality: assessed.quality,
          topContributions: assessed.contributions.slice(0, 5),
          assessmentId,
        },
      });
    }

    if (applied !== previous) {
      const escalated = riskRank(applied) > riskRank(previous);
      await this.repository.insertEvent(client, {
        sessionId: session.id,
        bookingId: session.bookingId,
        eventType: escalated ? 'RISK_ESCALATED' : 'RISK_DEESCALATED',
        source: risk.determinedBy === 'ML' ? 'ML' : 'RULE',
        riskLevel: applied,
        // Kaynak kanıt kısıtı: ML olayı model sürümü, kural olayı kural kimliği taşır.
        ...(risk.determinedBy === 'ML' && assessed !== null
          ? { modelVersion: assessed.modelVersion, anomalyScore: assessed.anomalyScore }
          : { ruleId: 'RISK-AGGREGATION', ruleVersion: RISK_AGGREGATION_VERSION }),
        details: {
          from: previous,
          to: applied,
          rules: activeRules,
          corroborated: risk.corroborated,
          warningFamilies: risk.warningFamilies,
          anomalyContributed: risk.anomalyContributed,
          assessmentId,
        },
      });

      await this.audit.record(client, {
        action: AuditAction.SAFETY_RISK_CHANGED,
        entityType: 'safety_session',
        entityId: session.id,
        oldValue: { riskLevel: previous },
        newValue: {
          riskLevel: applied,
          rulesetVersion: SAFETY_RULESET_VERSION,
          aggregationVersion: RISK_AGGREGATION_VERSION,
          rules: activeRules,
          assessmentId,
        },
      });

      // Operatör alarmı: HIGH_RISK'e **yükselişte** kalıcı event. Bu bir bildirimdir;
      // geri dönüşsüz hiçbir işlem (askı, ödeme, hesap) yapılmaz — o operatör
      // kararıdır (ADR-0008 §6). Yayın Faz 9 tüketicilerine outbox ile gider.
      if (escalated && riskRank(applied) >= riskRank('HIGH_RISK')) {
        await this.outbox.enqueue(client, {
          eventType: EventType.SAFETY_ALERT_RAISED,
          subjectType: 'safety_session',
          subjectId: session.id,
          // Anahtarlar event kataloğundaki sözleşmedir (event-catalog.md).
          payload: {
            safetySessionId: session.id,
            bookingId: session.bookingId,
            severity: applied,
            source: 'RULE_ENGINE',
            assessmentId,
          },
        });
      }
    }

    await this.repository.applyEvaluation(client, {
      sessionId: session.id,
      riskLevel: applied,
      activeRules,
      anomalyFlagged: risk.anomalyFlagged,
      nextEvaluationSeconds: this.config.env.SAFETY_EVALUATION_INTERVAL_SECONDS,
    });

    return { previous, applied, assessmentId };
  }
}

function emptyResult(
  status: EvaluationStatus,
  sessionId: string,
  started: number,
): EvaluationResult {
  return {
    status,
    sessionId,
    previousRiskLevel: null,
    riskLevel: null,
    computedRiskLevel: null,
    findings: [],
    anomaly: null,
    unavailableSignals: [],
    assessmentId: null,
    latencyMs: Date.now() - started,
  };
}

/**
 * Değerlendirme kaydına giden sinyaller: beklenen/gözlenen değerler, **koordinatsız**.
 * Kayıt append-only'dir ve retention'dan sonra da kalır.
 */
function serializeSignals(signals: SafetySignals, risk: RiskOutcome): Record<string, unknown> {
  return {
    sessionStatus: signals.sessionStatus,
    evaluatedAt: signals.evaluatedAt.toISOString(),
    expected: {
      scheduledStart: signals.scheduledStart.toISOString(),
      scheduledEnd: signals.scheduledEnd.toISOString(),
      telemetryIntervalSeconds: signals.telemetryIntervalSeconds,
      geofenceRadiusMeters: signals.geofenceRadiusMeters,
    },
    observed: {
      monitoringStartedAt: signals.monitoringStartedAt?.toISOString() ?? null,
      activatedAt: signals.activatedAt?.toISOString() ?? null,
      activationGeofenceState: signals.activationGeofenceState,
      geofenceState: signals.geofenceState,
      geofenceStateSeconds: signals.geofenceStateSeconds,
      lastDistanceMeters: signals.lastDistanceMeters,
      secondsSinceTelemetry: signals.secondsSinceTelemetry,
      telemetryCount: signals.telemetryCount,
      rejectedCount: signals.rejectedCount,
      integrityRejectionCount: signals.integrityRejectionCount,
      mockLocationCount: signals.mockLocationCount,
      recentMovementMeters: signals.recentMovementMeters,
      recentWindowSeconds: signals.recentWindowSeconds,
      recentSampleCount: signals.recentSampleCount,
      distanceTrendMeters: signals.distanceTrendMeters,
      recentLongGapCount: signals.recentLongGapCount,
      recentExitCount: signals.recentExitCount,
      geofenceEvidenceAgeSeconds: signals.geofenceEvidenceAgeSeconds,
      geofenceEvidenceSide: signals.geofenceEvidenceSide,
      routeEtaSeconds: signals.routeEtaSeconds,
    },
    aggregation: {
      corroborated: risk.corroborated,
      warningFamilies: risk.warningFamilies,
      anomalyFlagged: risk.anomalyFlagged,
      anomalyContributed: risk.anomalyContributed,
    },
  };
}
