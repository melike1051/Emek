import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { BookingStatus } from '../bookings/state/booking-status';
import { AuditAction, AuditService } from '../common/audit/audit.service';
import { AppConfigService } from '../common/config/app-config.service';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import type { SafetyClosureReason, SafetySessionStatus } from './safety.constants';
import { SafetyMetrics } from './safety-metrics';
import { forwardPath, opensSession, safetyEffectForBooking } from './safety-session.state';
import { SafetyRepository, type SafetySession, type SessionPolicy } from './safety.repository';

interface StepOrigin {
  actorUserId?: string | undefined;
  byOperator?: boolean;
}

const STEP_EVENT = {
  PRE_SERVICE: 'SESSION_STARTED',
  ARRIVAL_MONITORING: 'ARRIVAL_MONITORING_STARTED',
  ACTIVE: 'SESSION_ACTIVATED',
  CLOSED: 'SESSION_CLOSED',
} as const;

/**
 * Güvenlik oturumunun yaşam döngüsü (ADR-0019 §2).
 *
 * Oturum **rezervasyonu izler**; kendi iş yaşam döngüsü yoktur. Tek giriş noktası
 * `onBookingTransition`'dır ve `BookingStateService` tarafından, booking geçişiyle
 * **aynı transaction'da** çağrılır. Bu seçimin iki sonucu var ve ikisi de istenen:
 *
 * 1. Booking durumu değişip oturum değişmeden kalamaz (ya da tersi). Check-out
 *    commit edildiyse telemetri kapısı da kapanmıştır.
 * 2. Burada dış çağrı **yapılmaz**: booking geçişi AI, rota ya da bildirim
 *    servisine bağımlı hâle gelmemeli. Yalnızca veritabanı yazılır.
 *
 * Rezervasyon var diye oturum açılmaz: oturum ancak randevu kesinleşip ödeme
 * yetkilendirildiğinde (`SCHEDULED`) açılır ve o anda bile **telemetri kabul
 * etmez** — konum toplama sağlayıcı yola çıktığında (`PROVIDER_ARRIVING`) başlar.
 */
@Injectable()
export class SafetyLifecycleService {
  constructor(
    private readonly repository: SafetyRepository,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly metrics: SafetyMetrics,
  ) {}

  policy(): SessionPolicy {
    const env = this.config.env;
    return {
      radiusMeters: env.SAFETY_GEOFENCE_RADIUS_METERS,
      accuracyLimitMeters: env.SAFETY_GEOFENCE_ACCURACY_LIMIT_METERS,
      debounceSamples: env.SAFETY_GEOFENCE_DEBOUNCE_SAMPLES,
      telemetryIntervalSeconds: env.SAFETY_TELEMETRY_INTERVAL_SECONDS,
      telemetryMaxSkewSeconds: env.SAFETY_TELEMETRY_MAX_SKEW_SECONDS,
      telemetryMaxAgeSeconds: env.SAFETY_TELEMETRY_MAX_AGE_SECONDS,
      retentionDays: env.SAFETY_LOCATION_RETENTION_DAYS,
    };
  }

  /**
   * Booking geçişinin oturumdaki karşılığını uygular.
   *
   * Idempotenttir: oturum zaten hedefteyse hiçbir şey yazılmaz. Oturumu olmayan
   * bir rezervasyon (Faz 8 öncesinde planlanmış) ileri bir duruma geldiğinde oturum
   * açılır ve tablodaki adımlarla hedefe yürütülür.
   */
  async onBookingTransition(
    client: PoolClient,
    input: { bookingId: string; to: BookingStatus; actorUserId?: string },
  ): Promise<void> {
    const effect = safetyEffectForBooking(input.to);
    if (effect === null) {
      return;
    }

    let session = await this.repository.lockOpenSessionByBooking(client, input.bookingId);

    if (session === null) {
      if (!opensSession(effect)) {
        return;
      }
      const opened = await this.repository.openSession(client, input.bookingId, this.policy());
      if (opened === null) {
        // Sağlayıcısız rezervasyon: bookings_provider_required bunu SCHEDULED'da
        // zaten imkânsız kılar; savunma amaçlı sessiz dönüş.
        return;
      }
      session = opened.session;
      if (opened.created) {
        await this.recordStep(client, session, 'PRE_SERVICE', { actorUserId: input.actorUserId });
      }
    }

    const path = forwardPath(session.status, effect.target);
    if (path === null) {
      // Oturum hedefin ilerisinde (ör. askıdan dönüşte zaten aktif). Geri gitmek
      // yok; booking geçişi bu yüzden başarısız olmamalı.
      return;
    }

    for (const step of path) {
      await this.applyStep(client, session, step, effect.closureReason, {
        actorUserId: input.actorUserId,
      });
      session = { ...session, status: step };
    }
  }

  /** Operatör kapatması ve süre aşımı — tablo dışı tek yol, yine geçiş kurallarıyla. */
  async close(
    client: PoolClient,
    sessionId: string,
    reason: Extract<SafetyClosureReason, 'OPERATOR_CLOSED' | 'EXPIRED'>,
    actorUserId?: string,
  ): Promise<SafetySession> {
    const session = await this.repository.lockSession(client, sessionId);
    if (session === null) {
      throw new BusinessException(ErrorCode.SAFETY_SESSION_NOT_FOUND);
    }
    if (session.status === 'CLOSED') {
      throw new BusinessException(ErrorCode.SAFETY_SESSION_ALREADY_CLOSED);
    }
    if (forwardPath(session.status, 'CLOSED') === null) {
      throw new BusinessException(ErrorCode.SAFETY_INVALID_SESSION_TRANSITION, {
        details: { from: session.status, to: 'CLOSED' },
      });
    }

    await this.applyStep(client, session, 'CLOSED', reason, {
      actorUserId,
      byOperator: reason === 'OPERATOR_CLOSED' && actorUserId !== undefined,
    });
    const closed = await this.repository.lockSession(client, sessionId);
    if (closed === null) {
      throw new Error('kapatılan oturum okunamadı');
    }
    return closed;
  }

  private async applyStep(
    client: PoolClient,
    session: SafetySession,
    to: SafetySessionStatus,
    closureReason: SafetyClosureReason | undefined,
    origin: StepOrigin,
  ): Promise<void> {
    if (to === 'CLOSED') {
      await this.repository.transitionSession(client, {
        sessionId: session.id,
        to,
        closureReason: closureReason ?? 'OPERATOR_CLOSED',
      });
    } else {
      await this.repository.transitionSession(client, { sessionId: session.id, to });
    }

    await this.recordStep(client, { ...session, status: to }, to, origin, closureReason);
    this.metrics.record('safety.session.transition', {
      sessionId: session.id,
      from: session.status,
      to,
    });
  }

  private async recordStep(
    client: PoolClient,
    session: SafetySession,
    step: SafetySessionStatus,
    origin: StepOrigin,
    closureReason?: SafetyClosureReason,
  ): Promise<void> {
    const { actorUserId } = origin;
    if (step === 'NOT_STARTED') {
      return;
    }

    const details: Record<string, unknown> = { status: step };
    if (step === 'ACTIVE') {
      // Check-in anındaki kabul edilmiş geofence durumu: tek başına "hizmet başladı"
      // kanıtı değildir, tutarsızlık kuralının (R10) girdisidir.
      details.geofenceStateAtCheckIn = session.geofenceState;
    }
    if (step === 'CLOSED') {
      details.closureReason = closureReason ?? 'OPERATOR_CLOSED';
      details.telemetryCount = session.telemetryCount;
      details.rejectedCount = session.rejectedCount;
    }
    if (step === 'PRE_SERVICE') {
      // Politika kayda geçer: istemci ne ile doğrulandığını, operatör neyle
      // değerlendirildiğini sonradan görebilmeli.
      details.geofenceRadiusMeters = session.geofenceRadiusMeters;
      details.telemetryIntervalSeconds = session.telemetryIntervalSeconds;
    }

    await this.repository.insertEvent(client, {
      sessionId: session.id,
      bookingId: session.bookingId,
      eventType: STEP_EVENT[step],
      // Booking geçişinden gelen adım SYSTEM'dir; geçişi başlatan kişi yine de
      // kayda geçer. Yalnızca operatörün doğrudan kapatması OPERATOR kaynaklıdır.
      source: origin.byOperator === true ? 'OPERATOR' : 'SYSTEM',
      riskLevel: session.riskLevel,
      ...(actorUserId !== undefined ? { actorUserId } : {}),
      details,
    });

    if (step === 'PRE_SERVICE' || step === 'CLOSED') {
      await this.audit.record(client, {
        action:
          step === 'PRE_SERVICE'
            ? AuditAction.SAFETY_SESSION_STARTED
            : AuditAction.SAFETY_SESSION_CLOSED,
        entityType: 'safety_session',
        entityId: session.id,
        ...(actorUserId !== undefined ? { actorUserId } : {}),
        newValue: {
          bookingId: session.bookingId,
          status: step,
          ...(step === 'CLOSED' ? { closureReason: details.closureReason } : {}),
        },
      });
    }
  }
}
