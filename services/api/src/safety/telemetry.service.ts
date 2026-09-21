import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service';
import { UnitOfWork } from '../common/database/unit-of-work';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { acceptsTelemetry, type TelemetryRejectionReason } from './safety.constants';
import { SafetyMetrics } from './safety-metrics';
import { SafetyRepository, type LocationEventRow, type SafetySession } from './safety.repository';
import { processBatch, type GeofenceTransition, type SampleResult } from './telemetry-batch';
import {
  TELEMETRY_MIN_SPACING_SECONDS,
  TELEMETRY_REANCHOR_AFTER,
  type TelemetryPolicy,
  type TelemetrySample,
} from './telemetry-validator';

export type { SampleResult } from './telemetry-batch';

export interface IngestResult {
  sessionId: string;
  accepted: number;
  rejected: number;
  results: SampleResult[];
  /** İstemcinin bir sonraki gönderim için beklemesi gereken aralık. */
  telemetryIntervalSeconds: number;
}

/**
 * Telemetri kabulü (ADR-0008 §1, §7; ADR-0019 §3).
 *
 * İstek başına **tek, kısa** bir transaction: oturum kilitlenir, paket doğrulanır,
 * kabul edilen örnekler tek INSERT ile, oturum durumu tek UPDATE ile yazılır.
 * Bu yolda dış çağrı **yoktur** (AI, rota, bildirim): telemetri ingest'i hiçbir
 * isteğe bağlı bağımlılığın yavaşlığını devralmaz. Risk değerlendirmesi ayrı ve
 * zamanlanmış bir iştir (SafetyEvaluationService).
 *
 * İstemcinin söyledikleri **iddia**dır: sahiplik, oturumun aktifliği, geofence
 * sonucu ve risk seviyesi sunucuda türetilir; istemci bunları gönderemez bile
 * (DTO'da alanı yoktur).
 */
@Injectable()
export class TelemetryService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repository: SafetyRepository,
    private readonly config: AppConfigService,
    private readonly metrics: SafetyMetrics,
  ) {}

  policyFor(session: SafetySession): TelemetryPolicy {
    return {
      maxSkewSeconds: session.telemetryMaxSkewSeconds,
      maxAgeSeconds: session.telemetryMaxAgeSeconds,
      maxSpeedMps: this.config.env.SAFETY_MAX_SPEED_MPS,
      minSpacingSeconds: TELEMETRY_MIN_SPACING_SECONDS,
      reanchorAfter: TELEMETRY_REANCHOR_AFTER,
    };
  }

  async ingest(input: {
    sessionId: string;
    userId: string;
    samples: TelemetrySample[];
  }): Promise<IngestResult> {
    const started = Date.now();

    const outcome = await this.uow.withTransaction(async (client) => {
      const session = await this.repository.lockParticipantSession(
        client,
        input.sessionId,
        input.userId,
        true,
      );
      if (session === null) {
        // Başkasının oturumu ile var olmayan oturum aynı yanıtı alır.
        throw new BusinessException(ErrorCode.SAFETY_SESSION_NOT_FOUND);
      }
      if (session.status === 'CLOSED') {
        throw new BusinessException(ErrorCode.SAFETY_SESSION_ALREADY_CLOSED);
      }
      if (!acceptsTelemetry(session.status)) {
        // PRE_SERVICE: randevu var ama sağlayıcı yola çıkmadı. Konum toplamanın
        // amacı henüz yok (T-23); örnek saklanmaz ve sayılmaz.
        throw new BusinessException(ErrorCode.SAFETY_SESSION_NOT_ACTIVE);
      }

      const distances = await this.repository.distancesToService(client, session.id, input.samples);
      const batch = processBatch(
        {
          telemetry: {
            lastSequence: session.lastSequence,
            lastCapturedAt: session.lastCapturedAt,
            lastLatitude: session.lastLatitude,
            lastLongitude: session.lastLongitude,
            lastAccuracyMeters: session.lastAccuracyMeters,
            consecutiveSpeedRejections: session.consecutiveSpeedRejections,
            monitoringStartedAt: session.monitoringStartedAt,
          },
          geofence: {
            current: session.geofenceState,
            candidate: session.geofenceCandidateState,
            candidateCount: session.geofenceCandidateCount,
          },
        },
        input.samples,
        distances,
        new Date(),
        this.policyFor(session),
        {
          radiusMeters: session.geofenceRadiusMeters,
          accuracyLimitMeters: session.geofenceAccuracyLimitMeters,
          debounceSamples: session.geofenceDebounceSamples,
        },
      );

      const rows: LocationEventRow[] = batch.accepted.map(
        ({ sample, distanceMeters, observation }) => ({
          sequence: sample.sequence,
          capturedAt: sample.capturedAt,
          latitude: sample.latitude,
          longitude: sample.longitude,
          accuracyMeters: sample.accuracyMeters,
          speedMps: sample.speedMps,
          headingDegrees: sample.headingDegrees,
          isMockLocation: sample.isMockLocation,
          distanceMeters,
          geofenceState: observation,
        }),
      );
      await this.repository.insertLocationEvents(client, session.id, rows);

      const last = batch.accepted[batch.accepted.length - 1];
      const telemetry = batch.next.telemetry;
      const geofence = batch.next.geofence;
      const integrityRejections = [...batch.integrityRejections.values()].reduce(
        (sum, count) => sum + count,
        0,
      );

      const applied = await this.repository.applyTelemetry(client, {
        sessionId: session.id,
        previousSequence: session.lastSequence,
        lastSequence: telemetry.lastSequence,
        accepted: batch.accepted.length,
        rejected: batch.countedRejections,
        integrityRejections,
        mockLocations: batch.mockLocations,
        lastAccepted:
          last === undefined
            ? null
            : {
                capturedAt: last.sample.capturedAt,
                latitude: last.sample.latitude,
                longitude: last.sample.longitude,
                accuracyMeters: last.sample.accuracyMeters,
                distanceMeters: last.distanceMeters,
              },
        consecutiveSpeedRejections: telemetry.consecutiveSpeedRejections,
        geofence: {
          state: geofence.current,
          candidate: geofence.candidate,
          candidateCount: geofence.candidateCount,
          transitioned: batch.transitions.length > 0,
        },
      });
      if (!applied) {
        // Kilit altında olamaz; olursa kilitsiz bir yazma yolu eklenmiş demektir.
        throw new Error('telemetri durumu yazılamadı: oturum eşzamanlı değişti');
      }

      await this.recordEvents(
        session,
        client,
        batch.transitions,
        batch.integrityRejections,
        batch.reanchoredSequences,
      );

      return {
        session,
        results: batch.results,
        accepted: batch.accepted.length,
        rejected: batch.results.length - batch.accepted.length,
        transitions: batch.transitions,
      };
    });

    this.metrics.record('safety.telemetry.batch', {
      sessionId: outcome.session.id,
      received: input.samples.length,
      accepted: outcome.accepted,
      rejected: outcome.rejected,
      latencyMs: Date.now() - started,
    });
    for (const result of outcome.results) {
      if (result.reason !== null) {
        this.metrics.record('safety.telemetry.rejected', {
          sessionId: outcome.session.id,
          reason: result.reason,
        });
      }
    }
    for (const transition of outcome.transitions) {
      this.metrics.record('safety.geofence.transition', {
        sessionId: outcome.session.id,
        from: transition.from,
        to: transition.to,
      });
    }

    return {
      sessionId: outcome.session.id,
      accepted: outcome.accepted,
      rejected: outcome.rejected,
      results: outcome.results,
      telemetryIntervalSeconds: outcome.session.telemetryIntervalSeconds,
    };
  }

  /**
   * Anlamlı değişimler olaya dönüşür; her örnek değil.
   *
   * - Geofence: yalnızca **debounce edilmiş** geçişler. İlk kesin gözlem
   *   `OUTSIDE` ise olay yazılmaz — yola çıkan sağlayıcının dışarıda olması olağandır.
   * - Bütünlük retleri: paket başına **tek** olay, nedenlere göre sayılarla.
   *   Örnek başına olay, bir saldırganın tek istekle 20 olay yazdırmasına izin verirdi.
   */
  private async recordEvents(
    session: SafetySession,
    client: Parameters<SafetyRepository['insertEvent']>[0],
    transitions: GeofenceTransition[],
    integrity: Map<TelemetryRejectionReason, number>,
    reanchored: number[],
  ): Promise<void> {
    for (const transition of transitions) {
      const eventType =
        transition.to === 'INSIDE'
          ? 'GEOFENCE_ENTERED'
          : transition.from === 'INSIDE'
            ? 'GEOFENCE_EXITED'
            : null;
      if (eventType === null) {
        continue;
      }
      await this.repository.insertEvent(client, {
        sessionId: session.id,
        bookingId: session.bookingId,
        eventType,
        source: 'SYSTEM',
        riskLevel: session.riskLevel,
        // Mesafe ve doğruluk kanıttır; koordinat değildir.
        details: {
          from: transition.from,
          to: transition.to,
          sequence: transition.sequence,
          distanceMeters: transition.distanceMeters,
          accuracyMeters: Math.round(transition.accuracyMeters),
          radiusMeters: session.geofenceRadiusMeters,
          sessionStatus: session.status,
        },
      });
    }

    if (integrity.size > 0) {
      await this.repository.insertEvent(client, {
        sessionId: session.id,
        bookingId: session.bookingId,
        eventType: 'TELEMETRY_REJECTED',
        source: 'SYSTEM',
        riskLevel: session.riskLevel,
        details: { reasons: Object.fromEntries([...integrity.entries()].sort()) },
      });
    }

    if (reanchored.length > 0) {
      await this.repository.insertEvent(client, {
        sessionId: session.id,
        bookingId: session.bookingId,
        eventType: 'TELEMETRY_REANCHORED',
        source: 'SYSTEM',
        riskLevel: session.riskLevel,
        details: { sequences: reanchored },
      });
    }
  }
}
