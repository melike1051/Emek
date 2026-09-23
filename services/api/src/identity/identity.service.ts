import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditAction, AuditService } from '../common/audit/audit.service';
import { AppConfigService } from '../common/config/app-config.service';
import { UnitOfWork } from '../common/database/unit-of-work';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { EventType, OutboxService } from '../common/outbox/outbox.service';
import { UsersRepository } from '../users/users.repository';
import { IdentityRepository } from './identity.repository';
import {
  IDENTITY_PROVIDER,
  IdentityProviderError,
  IdentityProviderUnavailableError,
  type IdentityVerificationProvider,
  type VerificationResult,
} from './identity-provider.port';
import {
  isAtLeastAssurance,
  type AssuranceLevel,
  type IdentityRecord,
  type VerificationAttempt,
  type VerificationLevel,
  type VerificationPurpose,
} from './identity.types';

export interface StartedVerification {
  attemptId: string;
  clientToken: string;
  expiresAt: Date;
  method: string;
  purpose: VerificationPurpose;
}

export interface IdentityStatus {
  level: VerificationLevel;
  identityVerified: boolean;
  record: IdentityRecord | null;
}

export interface CallbackOutcome {
  status: 'VERIFIED' | 'REJECTED' | 'RECOVERY_PENDING_REVIEW';
  /** Kimliğin ait olduğu kanonik kullanıcı — recovery'de oturum açan kullanıcıdan farklı olabilir. */
  userId: string;
}

/**
 * Transaction içinde üretilen sonuç.
 *
 * Reddetme durumlarında exception **transaction içinde fırlatılmaz**: fırlatılsaydı
 * rollback ile birlikte reddetme audit'i ve `verification_attempts` güncellemesi de
 * kaybolurdu — yani "reddedildi" bilgisi hiç kaydedilmezdi. Sonuç commit edilir,
 * hata dışarıda üretilir.
 */
type CallbackResolution =
  | { kind: 'VERIFIED' | 'REJECTED'; userId: string }
  | { kind: 'RECOVERY_PENDING_REVIEW'; userId: string }
  | { kind: 'ALREADY_REGISTERED' }
  | { kind: 'RECOVERY_DENIED' }
  | { kind: 'SESSION_EXPIRED' }
  | { kind: 'UNKNOWN_SESSION' };

@Injectable()
export class IdentityService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repository: IdentityRepository,
    private readonly users: UsersRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly config: AppConfigService,
    @Inject(IDENTITY_PROVIDER) private readonly provider: IdentityVerificationProvider,
  ) {}

  /**
   * Kullanıcının etkin doğrulama seviyesi.
   *
   * Seviye türetilmiş bir değerdir: telefon doğrulaması oturum sağlayıcısından,
   * kimlik doğrulaması `identity_records`'tan gelir. Tek bir kolona yazılıp
   * güncellenmeyi beklemek, seviyenin sessizce eskimesine yol açardı.
   */
  async statusFor(userId: string): Promise<IdentityStatus> {
    const [user, record] = await Promise.all([
      this.users.findById(userId),
      this.repository.findByUserId(userId),
    ]);

    if (record !== null && record.verificationStatus === 'VERIFIED') {
      return { level: record.verificationLevel, identityVerified: true, record };
    }

    const level: VerificationLevel =
      user?.phone !== null && user?.phone !== undefined ? 'PHONE_VERIFIED' : 'UNVERIFIED';

    return { level, identityVerified: false, record };
  }

  /**
   * Doğrulama oturumu başlatır.
   *
   * Sağlayıcı erişilemezse **hiçbir kayıt oluşmaz**: yarım bir `verification_attempt`
   * bırakmak, sonraki denemeleri oran sınırına takar ve durumu belirsizleştirir (T-03).
   */
  async startSession(input: {
    userId: string;
    method: string;
    purpose: VerificationPurpose;
    ipAddress?: string;
  }): Promise<StartedVerification> {
    const capabilities = this.provider.capabilities();

    if (!capabilities.methods.includes(input.method)) {
      throw new BusinessException(ErrorCode.VALIDATION_FAILED, {
        clientMessage: 'Seçilen doğrulama yöntemi desteklenmiyor.',
        details: { supportedMethods: capabilities.methods },
      });
    }

    // ADR-0004 §3: deterministik hash üretemeyen sağlayıcı tekillik gerektiren
    // akışlarda tek başına kullanılamaz — doğrulanmış seviye verilemez.
    if (!capabilities.producesDeterministicIdentityHash) {
      throw new BusinessException(ErrorCode.VERIFICATION_FAILED, {
        clientMessage: 'Kimlik doğrulama sağlayıcısı şu anda kullanılamıyor.',
      });
    }

    const existing = await this.repository.findByUserId(input.userId);
    if (existing?.verificationStatus === 'VERIFIED' && input.purpose === 'ACCOUNT_VERIFICATION') {
      throw new BusinessException(ErrorCode.PROFILE_ALREADY_EXISTS, {
        clientMessage: 'Kimliğiniz zaten doğrulanmış.',
      });
    }

    const recentAttempts = await this.repository.countRecentAttempts(
      input.userId,
      this.config.env.VERIFICATION_ATTEMPT_WINDOW_SECONDS,
    );
    if (recentAttempts >= this.config.env.VERIFICATION_MAX_ATTEMPTS) {
      throw new BusinessException(ErrorCode.RATE_LIMITED, {
        clientMessage: 'Çok fazla doğrulama denemesi yapıldı, lütfen sonra tekrar deneyin.',
      });
    }

    let session;
    try {
      session = await this.provider.startSession({
        // Sağlayıcıya opak bir referans gider; Emek user id'si dış sisteme verilmez.
        userRef: this.opaqueUserRef(input.userId),
        method: input.method,
        purpose: input.purpose,
      });
    } catch (error) {
      if (error instanceof IdentityProviderUnavailableError) {
        throw new BusinessException(ErrorCode.SERVICE_DEGRADED, {
          clientMessage: 'Kimlik doğrulama servisine şu anda ulaşılamıyor, tekrar deneyin.',
        });
      }
      throw error;
    }

    return this.uow.withTransaction(async (client) => {
      const attempt = await this.repository.createAttempt(client, {
        userId: input.userId,
        provider: this.provider.name,
        externalSessionId: session.externalSessionId,
        method: input.method,
        purpose: input.purpose,
        expiresAt: session.expiresAt,
      });

      await this.audit.record(client, {
        action: AuditAction.IDENTITY_VERIFICATION_STARTED,
        entityType: 'verification_attempt',
        entityId: attempt.id,
        actorUserId: input.userId,
        newValue: { method: input.method, purpose: input.purpose, provider: this.provider.name },
        ...(input.ipAddress !== undefined ? { ipAddress: input.ipAddress } : {}),
      });

      return {
        attemptId: attempt.id,
        clientToken: session.clientToken,
        expiresAt: session.expiresAt,
        method: input.method,
        purpose: input.purpose,
      };
    });
  }

  getAttempt(attemptId: string, userId: string): Promise<VerificationAttempt | null> {
    return this.repository.findAttemptById(attemptId, userId);
  }

  /**
   * Sağlayıcı callback'ini işler.
   *
   * İmza doğrulaması adapter içindedir. Bu metot idempotenttir: aynı callback ikinci
   * kez geldiğinde (replay veya sağlayıcı retry'ı) yeni yan etki üretmez.
   */
  async handleCallback(rawBody: string, signature: string | undefined): Promise<CallbackOutcome> {
    let result: VerificationResult;
    try {
      result = await this.provider.verifyCallback(rawBody, signature);
    } catch (error) {
      if (error instanceof IdentityProviderError) {
        // Nedeni istemciye ayrıntılandırılmaz: imza hatası ile bilinmeyen oturum
        // aynı yanıtı döner.
        throw new BusinessException(ErrorCode.VERIFICATION_FAILED);
      }
      throw error;
    }

    const resolution = await this.uow.withTransaction<CallbackResolution>(async (client) => {
      const attempt = await this.repository.findAttemptBySession(
        this.provider.name,
        result.externalSessionId,
        client,
      );

      if (attempt === null) {
        return { kind: 'UNKNOWN_SESSION' };
      }

      // Replay koruması: tamamlanmış bir oturum yeniden işlenmez.
      if (attempt.status !== 'PENDING') {
        const record = await this.repository.findByUserId(attempt.userId, client);
        return {
          kind: record?.verificationStatus === 'VERIFIED' ? 'VERIFIED' : 'REJECTED',
          userId: attempt.userId,
        };
      }

      if (attempt.expiresAt.getTime() < Date.now()) {
        await this.repository.completeAttempt(client, attempt.id, {
          status: 'EXPIRED',
          resultCode: 'SESSION_EXPIRED',
          assuranceLevel: result.assuranceLevel,
        });
        return { kind: 'SESSION_EXPIRED' };
      }

      if (result.status !== 'VERIFIED' || result.identityHash === undefined) {
        await this.repository.completeAttempt(client, attempt.id, {
          status: 'REJECTED',
          resultCode: result.resultCode,
          assuranceLevel: result.assuranceLevel,
        });

        await this.audit.record(client, {
          action: AuditAction.IDENTITY_REJECTED,
          entityType: 'verification_attempt',
          entityId: attempt.id,
          actorUserId: attempt.userId,
          newValue: { resultCode: result.resultCode },
        });

        return { kind: 'REJECTED', userId: attempt.userId };
      }

      const hashOwnerId = await this.repository.findUserIdByHash(result.identityHash, client);

      if (hashOwnerId !== null && hashOwnerId !== attempt.userId) {
        return this.resolveExistingIdentity(client, attempt, result, hashOwnerId);
      }

      return this.completeVerification(client, attempt, result);
    });

    // Reddetme kayıtları commit edildikten sonra hata üretilir.
    switch (resolution.kind) {
      case 'UNKNOWN_SESSION':
        throw new BusinessException(ErrorCode.VERIFICATION_FAILED);
      case 'SESSION_EXPIRED':
        throw new BusinessException(ErrorCode.VERIFICATION_SESSION_EXPIRED);
      case 'ALREADY_REGISTERED':
        throw new BusinessException(ErrorCode.IDENTITY_ALREADY_REGISTERED);
      case 'RECOVERY_DENIED':
        throw new BusinessException(ErrorCode.RECOVERY_NOT_ALLOWED);
      default:
        return { status: resolution.kind, userId: resolution.userId };
    }
  }

  private async completeVerification(
    client: PoolClient,
    attempt: VerificationAttempt,
    result: VerificationResult,
  ): Promise<CallbackResolution> {
    await this.repository.completeAttempt(client, attempt.id, {
      status: 'VERIFIED',
      resultCode: result.resultCode,
      assuranceLevel: result.assuranceLevel,
    });

    const record = await this.repository.upsertVerified(client, {
      userId: attempt.userId,
      provider: this.provider.name,
      providerSubjectId: result.providerSubjectId,
      identityHash: result.identityHash as string,
      hashKeyVersion: result.hashKeyVersion ?? 'unknown',
      assuranceLevel: result.assuranceLevel,
      verifiedAt: result.verifiedAt ?? new Date(),
    });

    await this.audit.record(client, {
      action: AuditAction.IDENTITY_VERIFIED,
      entityType: 'identity_record',
      entityId: attempt.userId,
      actorUserId: attempt.userId,
      // Hash ve ham kimlik verisi audit'e yazılmaz (ADR-0013 §10).
      newValue: {
        provider: this.provider.name,
        assuranceLevel: record.assuranceLevel,
        level: record.verificationLevel,
      },
    });

    await this.outbox.enqueue(client, {
      eventType: EventType.IDENTITY_VERIFIED,
      subjectType: 'user',
      subjectId: attempt.userId,
      payload: {
        userId: attempt.userId,
        verificationLevel: record.verificationLevel,
        assuranceLevel: record.assuranceLevel,
      },
    });

    return { kind: 'VERIFIED', userId: attempt.userId };
  }

  /**
   * Aynı kimlik başka bir kullanıcıya ait: ikinci doğrulanmış hesap **açılmaz** (ADR-0004).
   *
   * `ACCOUNT_VERIFICATION` ise istek reddedilir.
   *
   * `ACCOUNT_RECOVERY` ise **otomatik devir yapılmaz**, inceleme talebi oluşturulur.
   * Gerekçe (Faz 3 güvenlik düzeltmesi): kurtarma oturumunu saldırgan başlatıp bağlantıyı
   * mağdura ulaştırabilir; mağdur kendi belgesiyle gerçek ve yüksek güvenceli bir doğrulama
   * yapar. Güvence seviyesi belgeyi sunanın canlı olduğunu kanıtlar ama **oturumu başlatanın
   * kim olduğunu kanıtlamaz** — otomatik devir bu durumda saldırganın oturum kimliğini
   * mağdurun hesabına taşırdı. Bu yüzden kimlik eşleşmesi kurtarmanın **girdisidir**,
   * tamamlayıcısı değildir.
   */
  private async resolveExistingIdentity(
    client: PoolClient,
    attempt: VerificationAttempt,
    result: VerificationResult,
    ownerUserId: string,
  ): Promise<CallbackResolution> {
    if (attempt.purpose !== 'ACCOUNT_RECOVERY') {
      await this.repository.completeAttempt(client, attempt.id, {
        status: 'REJECTED',
        resultCode: 'IDENTITY_ALREADY_REGISTERED',
        assuranceLevel: result.assuranceLevel,
      });

      await this.audit.record(client, {
        action: AuditAction.IDENTITY_REJECTED,
        entityType: 'verification_attempt',
        entityId: attempt.id,
        actorUserId: attempt.userId,
        newValue: { resultCode: 'IDENTITY_ALREADY_REGISTERED' },
      });

      return { kind: 'ALREADY_REGISTERED' };
    }

    // Kurtarma yine de en yüksek güvence seviyesini ister: zayıf doğrulamayla inceleme
    // kuyruğunu doldurmak da bir saldırı yüzeyidir.
    if (!isAtLeastAssurance(result.assuranceLevel, this.config.env.RECOVERY_MIN_ASSURANCE)) {
      await this.repository.completeAttempt(client, attempt.id, {
        status: 'REJECTED',
        resultCode: 'INSUFFICIENT_ASSURANCE',
        assuranceLevel: result.assuranceLevel,
      });

      await this.audit.record(client, {
        action: AuditAction.ACCOUNT_RECOVERY_REJECTED,
        entityType: 'user',
        entityId: ownerUserId,
        actorUserId: attempt.userId,
        newValue: {
          resultCode: 'INSUFFICIENT_ASSURANCE',
          provided: result.assuranceLevel,
          required: this.config.env.RECOVERY_MIN_ASSURANCE,
        },
      });

      return { kind: 'RECOVERY_DENIED' };
    }

    // Kabuk hesap kendi verisini oluşturmuşsa kurtarma bu veriyi kapatılan hesapta
    // asılı bırakırdı: operasyon incelemesi gerekir, otomatik talep açılmaz.
    if (await this.repository.hasOwnData(attempt.userId, client)) {
      await this.repository.completeAttempt(client, attempt.id, {
        status: 'REJECTED',
        resultCode: 'RECOVERY_REQUIRES_REVIEW',
        assuranceLevel: result.assuranceLevel,
      });

      await this.audit.record(client, {
        action: AuditAction.ACCOUNT_RECOVERY_REJECTED,
        entityType: 'user',
        entityId: ownerUserId,
        actorUserId: attempt.userId,
        newValue: { resultCode: 'RECOVERY_REQUIRES_REVIEW', shellUserId: attempt.userId },
      });

      return { kind: 'RECOVERY_DENIED' };
    }

    await this.repository.completeAttempt(client, attempt.id, {
      status: 'VERIFIED',
      resultCode: 'RECOVERY_PENDING_REVIEW',
      assuranceLevel: result.assuranceLevel,
    });

    const requestId = await this.repository.createRecoveryRequest(client, {
      requesterUserId: attempt.userId,
      targetUserId: ownerUserId,
      verificationAttemptId: attempt.id,
      assuranceLevel: result.assuranceLevel,
    });

    if (requestId === null) {
      // Hedef hesap için zaten bekleyen bir talep var: yenisi açılmaz.
      return { kind: 'RECOVERY_DENIED' };
    }

    await this.audit.record(client, {
      action: AuditAction.ACCOUNT_RECOVERY_REQUESTED,
      entityType: 'account_recovery_request',
      entityId: requestId,
      actorUserId: attempt.userId,
      newValue: {
        targetUserId: ownerUserId,
        assuranceLevel: result.assuranceLevel,
        provider: this.provider.name,
      },
    });

    return { kind: 'RECOVERY_PENDING_REVIEW', userId: attempt.userId };
  }

  /**
   * Kurtarma kuyruğu (admin, Faz 10).
   *
   * Varsayılan olarak yalnızca bekleyen talepler döner: operatörün karar vermesi
   * gereken kuyruk budur. Geçmiş kararları görmek için `status` açıkça verilir.
   */
  async listRecoveryQueue(filter: {
    status?: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';
    limit: number;
    before?: { createdAt: Date; id: string };
  }): Promise<
    Array<{
      id: string;
      requesterUserId: string;
      targetUserId: string;
      status: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';
      assuranceLevel: AssuranceLevel;
      createdAt: Date;
      decidedAt: Date | null;
      decidedBy: string | null;
      decisionReason: string | null;
    }>
  > {
    return this.repository.listRecoveryRequests(filter);
  }

  /**
   * Kurtarma talebini onaylar ve oturum kimliğini kanonik hesaba taşır.
   *
   * **Operatör aksiyonudur**: kimlik eşleşmesi tek başına yeterli değildir (yukarıdaki
   * devralma senaryosu). Admin API'si bu metodu `ADMIN` rolüne bağlı olarak açar
   * (Faz 10); imza operatör kimliğini zorunlu tutar ki audit'te "kim onayladı"
   * bilgisi her zaman bulunsun.
   */
  async approveRecovery(input: {
    requestId: string;
    actorUserId: string;
    reason?: string;
  }): Promise<{ recoveredUserId: string }> {
    return this.uow.withTransaction(async (client) => {
      const request = await this.repository.findRecoveryRequest(input.requestId, client);

      if (request === null) {
        throw new BusinessException(ErrorCode.NOT_FOUND);
      }

      if (request.status !== 'PENDING_REVIEW') {
        throw new BusinessException(ErrorCode.RECOVERY_REQUEST_NOT_PENDING);
      }

      /*
       * Operatör onayı **bağımsız** bir kontroldür (R-36).
       *
       * Faz 3'te otomatik devir kaldırıldı ve taşıma operatör onayına bağlandı; ama
       * onaylayanın talebin tarafı olamayacağı hiçbir yerde zorlanmıyordu. ADMIN rolü
       * taşıyan bir saldırgan kendi açtığı kurtarma talebini kendisi onaylayarak
       * kaldırılmış olan devralma yolunu geri getirebilirdi — kontrol bir formaliteye
       * dönüşürdü. Hedef hesabın kendi talebini onaylaması da aynı şekilde bağımsız
       * değildir.
       *
       * Ret **audit'e yazılmaz ve talebi kapatmaz**: talep geçerli olabilir, yalnızca
       * bu onaylayan uygun değildir. Başka bir operatör inceleyebilmeli.
       */
      if (
        input.actorUserId === request.requesterUserId ||
        input.actorUserId === request.targetUserId
      ) {
        throw new BusinessException(ErrorCode.RECOVERY_NOT_ALLOWED, {
          clientMessage: 'Kendi kurtarma talebinizi onaylayamazsınız.',
        });
      }

      // Onay anında tekrar kontrol: talep açıldıktan sonra kabuk hesap veri oluşturmuş olabilir.
      if (await this.repository.hasOwnData(request.requesterUserId, client)) {
        await this.repository.decideRecoveryRequest(client, {
          id: request.id,
          status: 'REJECTED',
          decidedBy: input.actorUserId,
          reason: 'REQUESTER_HAS_OWN_DATA',
        });
        throw new BusinessException(ErrorCode.RECOVERY_NOT_ALLOWED);
      }

      const subject = await this.users.findAuthSubject(request.requesterUserId, client);
      if (subject === null) {
        throw new BusinessException(ErrorCode.RECOVERY_NOT_ALLOWED);
      }

      await this.repository.decideRecoveryRequest(client, {
        id: request.id,
        status: 'APPROVED',
        decidedBy: input.actorUserId,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      });

      await this.users.moveAuthSubject(client, {
        provider: subject.provider,
        subject: subject.providerSubject,
        fromUserId: request.requesterUserId,
        toUserId: request.targetUserId,
      });

      await this.users.markDeleted(client, request.requesterUserId);

      await this.audit.record(client, {
        action: AuditAction.ACCOUNT_RECOVERED,
        entityType: 'user',
        entityId: request.targetUserId,
        actorUserId: input.actorUserId,
        oldValue: { shellUserId: request.requesterUserId },
        newValue: { requestId: request.id, assuranceLevel: request.assuranceLevel },
      });

      return { recoveredUserId: request.targetUserId };
    });
  }

  /** Kurtarma talebini reddeder (operatör aksiyonu, Faz 10 admin API'si üzerinden çağrılır). */
  async rejectRecovery(input: {
    requestId: string;
    actorUserId: string;
    reason: string;
  }): Promise<void> {
    await this.uow.withTransaction(async (client) => {
      const request = await this.repository.findRecoveryRequest(input.requestId, client);
      if (request === null) {
        throw new BusinessException(ErrorCode.NOT_FOUND);
      }
      if (request.status !== 'PENDING_REVIEW') {
        throw new BusinessException(ErrorCode.RECOVERY_REQUEST_NOT_PENDING);
      }

      await this.repository.decideRecoveryRequest(client, {
        id: request.id,
        status: 'REJECTED',
        decidedBy: input.actorUserId,
        reason: input.reason,
      });

      await this.audit.record(client, {
        action: AuditAction.ACCOUNT_RECOVERY_REJECTED,
        entityType: 'account_recovery_request',
        entityId: request.id,
        actorUserId: input.actorUserId,
        newValue: { reason: input.reason },
      });
    });
  }

  /**
   * Sağlayıcıya gönderilen opak referans.
   *
   * Emek user id'si dış sisteme verilmez: sağlayıcı tarafındaki bir veri sızıntısı
   * Emek kullanıcı kimliklerini doğrudan ifşa etmemeli. Referans, callback sırrıyla
   * türetilmiş takma addır — sağlayıcı için kararlı, dışarısı için anlamsız.
   */
  private opaqueUserRef(userId: string): string {
    return createHmac('sha256', this.config.env.IDENTITY_CALLBACK_SECRET)
      .update(`user-ref:${userId}`, 'utf8')
      .digest('hex')
      .slice(0, 32);
  }
}
