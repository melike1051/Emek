import { Injectable } from '@nestjs/common';
import { AuditAction, AuditService } from '../common/audit/audit.service';
import { UnitOfWork } from '../common/database/unit-of-work';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { EventType, OutboxService } from '../common/outbox/outbox.service';
import { UsersRepository } from './users.repository';
import type { AppRole, User } from './user.types';

/** PostgreSQL unique_violation. */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

export interface SessionResult {
  user: User;
  /** Bu çağrıda yeni kullanıcı oluşturulduysa true (istemci onboarding'e yönlendirir). */
  registered: boolean;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repository: UsersRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  findByProviderSubject(subject: string): Promise<User | null> {
    return this.repository.findByProviderSubject(subject);
  }

  findById(id: string): Promise<User | null> {
    return this.repository.findById(id);
  }

  /**
   * Doğrulanmış token'dan oturum kurar; kullanıcı yoksa oluşturur.
   *
   * Kullanıcı oluşturma, rol atama, audit kaydı ve `UserRegistered` event'i **tek
   * transaction'da** yazılır (ADR-0010 §2, ADR-0013 §9): biri başarısız olursa hiçbiri olmaz.
   */
  async ensureSession(input: {
    subject: string;
    email?: string;
    phone?: string;
    ipAddress?: string;
  }): Promise<SessionResult> {
    const existing = await this.repository.findByProviderSubject(input.subject);

    if (existing !== null) {
      await this.uow.withTransaction(async (client) => {
        await this.repository.touchLastLogin(client, existing.id);
      });
      return { user: existing, registered: false };
    }

    // Her kullanıcının en az bir iletişim kanalı olmalı (users_contact_present CHECK).
    // Sağlayıcı ikisini de döndürmezse bu bir yapılandırma/akış hatasıdır: istemciye
    // anlamlı bir kod dönmeli, veritabanı hatası 500'e dönüşmemeli.
    if (input.email === undefined && input.phone === undefined) {
      throw new BusinessException(ErrorCode.AUTH_CONTACT_REQUIRED);
    }

    try {
      return await this.createSession(input);
    } catch (error) {
      // Aynı subject için iki istek aynı anda gelirse ikisi de "kullanıcı yok"
      // görür; biri INSERT'i kazanır, diğeri unique ihlali alır. Bu bir yarış
      // koşuludur, hata değil: kaybeden taraf mevcut kullanıcıyı okur.
      if (isUniqueViolation(error)) {
        const existingAfterRace = await this.repository.findByProviderSubject(input.subject);
        if (existingAfterRace !== null) {
          return { user: existingAfterRace, registered: false };
        }
      }
      throw error;
    }
  }

  private async createSession(input: {
    subject: string;
    email?: string;
    phone?: string;
    ipAddress?: string;
  }): Promise<SessionResult> {
    return this.uow.withTransaction(async (client) => {
      const created = await this.repository.createWithSubject(client, {
        subject: input.subject,
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
      });

      // Her yeni kullanıcı varsayılan olarak müşteridir; sağlayıcı rolü profil
      // oluşturulduğunda verilir (ADR-0004: tek User, çok rol).
      await this.repository.grantRole(client, created.id, 'CUSTOMER');

      await this.audit.record(client, {
        action: AuditAction.USER_REGISTERED,
        entityType: 'user',
        entityId: created.id,
        actorUserId: created.id,
        newValue: { status: created.status, roles: ['CUSTOMER'] },
        ...(input.ipAddress !== undefined ? { ipAddress: input.ipAddress } : {}),
      });

      await this.outbox.enqueue(client, {
        eventType: EventType.USER_REGISTERED,
        subjectType: 'user',
        subjectId: created.id,
        // Kişisel veri event payload'ında taşınmaz (event-catalog.md §1).
        payload: { userId: created.id, roles: ['CUSTOMER'] },
      });

      const user = await this.repository.findById(created.id, client);
      if (user === null) {
        throw new Error('oluşturulan kullanıcı okunamadı');
      }

      return { user, registered: true };
    });
  }

  async updateContact(
    userId: string,
    changes: { email?: string; phone?: string },
    actorUserId: string,
  ): Promise<User> {
    const before = await this.repository.findById(userId);
    if (before === null) {
      throw new BusinessException(ErrorCode.NOT_FOUND);
    }

    return this.uow.withTransaction(async (client) => {
      const updated = await this.repository.updateContact(client, userId, changes);

      await this.audit.record(client, {
        action: AuditAction.USER_UPDATED,
        entityType: 'user',
        entityId: userId,
        actorUserId,
        // Audit, iletişim bilgisinin **değiştiğini** kaydeder; değerleri taşımaz (ADR-0013 §10).
        oldValue: { emailPresent: before.email !== null, phonePresent: before.phone !== null },
        newValue: { emailPresent: updated.email !== null, phonePresent: updated.phone !== null },
      });

      return updated;
    });
  }

  /** Rol verme audit'lidir: yetki değişimi her zaman izlenebilir olmalı (ADR-0013). */
  async grantRole(userId: string, role: AppRole, actorUserId: string): Promise<void> {
    await this.uow.withTransaction(async (client) => {
      const granted = await this.repository.grantRole(client, userId, role);
      if (!granted) {
        return;
      }

      await this.audit.record(client, {
        action: AuditAction.ROLE_GRANTED,
        entityType: 'user',
        entityId: userId,
        actorUserId,
        newValue: { role },
      });
    });
  }
}
