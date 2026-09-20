import { Injectable } from '@nestjs/common';
import { AuditAction, AuditService } from '../common/audit/audit.service';
import { UnitOfWork } from '../common/database/unit-of-work';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';

export interface CustomerProfile {
  userId: string;
  displayName: string;
  preferences: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

interface CustomerRow {
  user_id: string;
  display_name: string;
  preferences: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

function toProfile(row: CustomerRow): CustomerProfile {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    preferences: row.preferences,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

@Injectable()
export class CustomersService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly audit: AuditService,
  ) {}

  /**
   * Profil okuma her zaman `userId` ile kapsanır.
   *
   * Sorgunun kendisi kullanıcıya bağlı olduğu için guard atlanmış olsa dahi başka bir
   * kullanıcının profili dönemez (ADR-0013 §3: yetki kontrolü veri erişim katmanında da).
   */
  async findByUserId(userId: string): Promise<CustomerProfile | null> {
    const rows = await this.uow.query<CustomerRow>(
      `SELECT user_id, display_name, preferences, created_at, updated_at
         FROM customer_profiles WHERE user_id = $1`,
      [userId],
    );
    const row = rows[0];
    return row === undefined ? null : toProfile(row);
  }

  async create(
    userId: string,
    input: { displayName: string; preferences?: Record<string, unknown> },
  ): Promise<CustomerProfile> {
    return this.uow.withTransaction(async (client) => {
      const inserted = await client.query<CustomerRow>(
        `INSERT INTO customer_profiles (user_id, display_name, preferences)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO NOTHING
         RETURNING user_id, display_name, preferences, created_at, updated_at`,
        [userId, input.displayName, JSON.stringify(input.preferences ?? {})],
      );

      const row = inserted.rows[0];
      if (row === undefined) {
        throw new BusinessException(ErrorCode.PROFILE_ALREADY_EXISTS);
      }

      await this.audit.record(client, {
        action: AuditAction.CUSTOMER_PROFILE_CREATED,
        entityType: 'customer_profile',
        entityId: userId,
        actorUserId: userId,
      });

      return toProfile(row);
    });
  }

  async update(
    userId: string,
    changes: { displayName?: string; preferences?: Record<string, unknown> },
  ): Promise<CustomerProfile> {
    return this.uow.withTransaction(async (client) => {
      const updated = await client.query<CustomerRow>(
        `UPDATE customer_profiles
            SET display_name = COALESCE($2, display_name),
                preferences = COALESCE($3::jsonb, preferences)
          WHERE user_id = $1
          RETURNING user_id, display_name, preferences, created_at, updated_at`,
        [
          userId,
          changes.displayName ?? null,
          changes.preferences === undefined ? null : JSON.stringify(changes.preferences),
        ],
      );

      const row = updated.rows[0];
      if (row === undefined) {
        throw new BusinessException(ErrorCode.PROFILE_NOT_FOUND);
      }

      await this.audit.record(client, {
        action: AuditAction.CUSTOMER_PROFILE_UPDATED,
        entityType: 'customer_profile',
        entityId: userId,
        actorUserId: userId,
        newValue: { fields: Object.keys(changes) },
      });

      return toProfile(row);
    });
  }
}
