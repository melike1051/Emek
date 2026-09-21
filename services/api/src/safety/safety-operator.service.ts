import { Injectable } from '@nestjs/common';
import { AuditAction, AuditService } from '../common/audit/audit.service';
import { UnitOfWork } from '../common/database/unit-of-work';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import type { RiskLevel } from './safety.constants';
import { SafetyLifecycleService } from './safety-lifecycle.service';
import { SafetyRepository, isPanicActive, type SafetySession } from './safety.repository';

/** Operatörün bir oturumdan okuyabileceği en fazla ham konum örneği. */
export const OPERATOR_LOCATION_LIMIT = 500;

/**
 * Operatör aksiyonları (ADR-0013 §4, ADR-0019 §9).
 *
 * İnsan kararı gerektiren her şey buradadır ve her biri **audit'lenir**:
 * risk seviyesini değiştirmek (acil durumu çözmek dahil), oturumu kapatmak ve ham
 * konum izini okumak. Sonuncusu bir okuma olmasına rağmen audit'lenir: güvenlik
 * verisinin en hassas parçası kişinin saniye saniye nerede olduğudur ve operatör
 * erişimi kötüye kullanıma açık bir yüzeydir (admin misuse, tehdit modeli).
 *
 * Rezervasyon askısını (`SAFETY_HOLD`) kaldırmak burada **değildir**: o bir booking
 * geçişidir ve mevcut `POST /bookings/:id/transitions` (ADMIN) yolundan geçer.
 * İki ayrı karar: "risk bitti" ile "hizmet devam edebilir" aynı şey değildir.
 */
@Injectable()
export class SafetyOperatorService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repository: SafetyRepository,
    private readonly lifecycle: SafetyLifecycleService,
    private readonly audit: AuditService,
  ) {}

  async overrideRisk(input: {
    sessionId: string;
    actorUserId: string;
    riskLevel: RiskLevel;
    reason: string;
  }): Promise<SafetySession> {
    return this.uow.withTransaction(async (client) => {
      const session = await this.repository.lockSession(client, input.sessionId);
      if (session === null) {
        throw new BusinessException(ErrorCode.SAFETY_SESSION_NOT_FOUND);
      }
      if (session.status === 'CLOSED') {
        throw new BusinessException(ErrorCode.SAFETY_SESSION_ALREADY_CLOSED);
      }

      const resolvesPanic = isPanicActive(session) && input.riskLevel !== 'EMERGENCY';
      await this.repository.overrideRisk(client, session.id, input.riskLevel);

      await this.repository.insertEvent(client, {
        sessionId: session.id,
        bookingId: session.bookingId,
        eventType: 'RISK_OVERRIDDEN',
        source: 'OPERATOR',
        riskLevel: input.riskLevel,
        actorUserId: input.actorUserId,
        details: {
          from: session.riskLevel,
          to: input.riskLevel,
          reason: input.reason,
          resolvesPanic,
        },
      });

      await this.audit.record(client, {
        action: AuditAction.SAFETY_RISK_OVERRIDDEN,
        entityType: 'safety_session',
        entityId: session.id,
        actorUserId: input.actorUserId,
        oldValue: { riskLevel: session.riskLevel },
        newValue: { riskLevel: input.riskLevel, reason: input.reason, resolvesPanic },
      });

      const updated = await this.repository.lockSession(client, session.id);
      if (updated === null) {
        throw new Error('güncellenen oturum okunamadı');
      }
      return updated;
    });
  }

  async close(input: { sessionId: string; actorUserId: string }): Promise<SafetySession> {
    return this.uow.withTransaction((client) =>
      this.lifecycle.close(client, input.sessionId, 'OPERATOR_CLOSED', input.actorUserId),
    );
  }

  /** Ham iz — audit'li okuma. Retention sonrasında boş döner. */
  async readLocations(input: { sessionId: string; actorUserId: string; limit: number }) {
    const session = await this.repository.findById(input.sessionId);
    if (session === null) {
      throw new BusinessException(ErrorCode.SAFETY_SESSION_NOT_FOUND);
    }

    const limit = Math.min(Math.max(1, input.limit), OPERATOR_LOCATION_LIMIT);
    const locations = await this.repository.listLocations(session.id, limit);

    await this.uow.withTransaction((client) =>
      this.audit.record(client, {
        action: AuditAction.SAFETY_LOCATION_ACCESSED,
        entityType: 'safety_session',
        entityId: session.id,
        actorUserId: input.actorUserId,
        newValue: { returned: locations.length, limit },
      }),
    );

    return { session, locations };
  }
}
