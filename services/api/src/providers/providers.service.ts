import { Injectable } from '@nestjs/common';
import { AuditAction, AuditService } from '../common/audit/audit.service';
import { UnitOfWork } from '../common/database/unit-of-work';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { EventType, OutboxService } from '../common/outbox/outbox.service';
import { UsersRepository } from '../users/users.repository';

export const PROVIDER_STATES = [
  'DRAFT',
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
  'SUSPENDED',
] as const;
export type ProviderState = (typeof PROVIDER_STATES)[number];

export const SKILL_LEVELS = ['BEGINNER', 'INTERMEDIATE', 'EXPERT'] as const;
export type SkillLevel = (typeof SKILL_LEVELS)[number];

export interface ProviderProfile {
  userId: string;
  displayName: string;
  bio: string | null;
  experienceYears: number | null;
  ratingAvg: number | null;
  ratingCount: number;
  state: ProviderState;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProviderSkill {
  skillId: string;
  slug: string;
  name: string;
  level: SkillLevel;
  verified: boolean;
}

interface ProviderRow {
  user_id: string;
  display_name: string;
  bio: string | null;
  experience_years: string | null;
  rating_avg: string | null;
  rating_count: number;
  state: ProviderState;
  created_at: Date;
  updated_at: Date;
}

function toProfile(row: ProviderRow): ProviderProfile {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    bio: row.bio,
    // NUMERIC, pg tarafından string olarak döner; sayıya çevirme tek yerde yapılır.
    experienceYears: row.experience_years === null ? null : Number(row.experience_years),
    ratingAvg: row.rating_avg === null ? null : Number(row.rating_avg),
    ratingCount: row.rating_count,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_PROFILE = `
  SELECT user_id, display_name, bio, experience_years, rating_avg, rating_count,
         state, created_at, updated_at
    FROM provider_profiles
`;

@Injectable()
export class ProvidersService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly users: UsersRepository,
  ) {}

  async findByUserId(userId: string): Promise<ProviderProfile | null> {
    const rows = await this.uow.query<ProviderRow>(`${SELECT_PROFILE} WHERE user_id = $1`, [
      userId,
    ]);
    const row = rows[0];
    return row === undefined ? null : toProfile(row);
  }

  /**
   * Sağlayıcı profili oluşturur ve kullanıcıya `PROVIDER` rolünü verir.
   *
   * Profil, rol, audit ve event aynı transaction'da yazılır. Profil `DRAFT` durumunda
   * başlar: onay akışı Faz 3'te (kimlik + belge doğrulaması) devreye girer — bu yüzden
   * burada `APPROVED` verilmez.
   */
  async create(
    userId: string,
    input: { displayName: string; bio?: string; experienceYears?: number },
  ): Promise<ProviderProfile> {
    return this.uow.withTransaction(async (client) => {
      const inserted = await client.query<ProviderRow>(
        `INSERT INTO provider_profiles (user_id, display_name, bio, experience_years)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO NOTHING
         RETURNING user_id, display_name, bio, experience_years, rating_avg, rating_count,
                   state, created_at, updated_at`,
        [userId, input.displayName, input.bio ?? null, input.experienceYears ?? null],
      );

      const row = inserted.rows[0];
      if (row === undefined) {
        throw new BusinessException(ErrorCode.PROFILE_ALREADY_EXISTS);
      }

      const roleGranted = await this.users.grantRole(client, userId, 'PROVIDER');

      await this.audit.record(client, {
        action: AuditAction.PROVIDER_PROFILE_CREATED,
        entityType: 'provider_profile',
        entityId: userId,
        actorUserId: userId,
        newValue: { state: row.state },
      });

      if (roleGranted) {
        await this.audit.record(client, {
          action: AuditAction.ROLE_GRANTED,
          entityType: 'user',
          entityId: userId,
          actorUserId: userId,
          newValue: { role: 'PROVIDER' },
        });
      }

      await this.outbox.enqueue(client, {
        eventType: EventType.PROVIDER_PROFILE_SUBMITTED,
        subjectType: 'provider_profile',
        subjectId: userId,
        payload: { providerId: userId, state: row.state },
      });

      return toProfile(row);
    });
  }

  async update(
    userId: string,
    changes: { displayName?: string; bio?: string; experienceYears?: number },
  ): Promise<ProviderProfile> {
    return this.uow.withTransaction(async (client) => {
      const updated = await client.query<ProviderRow>(
        `UPDATE provider_profiles
            SET display_name = COALESCE($2, display_name),
                bio = CASE WHEN $3::boolean THEN $4 ELSE bio END,
                experience_years = CASE WHEN $5::boolean THEN $6 ELSE experience_years END
          WHERE user_id = $1
          RETURNING user_id, display_name, bio, experience_years, rating_avg, rating_count,
                    state, created_at, updated_at`,
        [
          userId,
          changes.displayName ?? null,
          changes.bio !== undefined,
          changes.bio ?? null,
          changes.experienceYears !== undefined,
          changes.experienceYears ?? null,
        ],
      );

      const row = updated.rows[0];
      if (row === undefined) {
        throw new BusinessException(ErrorCode.PROFILE_NOT_FOUND);
      }

      await this.audit.record(client, {
        action: AuditAction.PROVIDER_PROFILE_UPDATED,
        entityType: 'provider_profile',
        entityId: userId,
        actorUserId: userId,
        newValue: { fields: Object.keys(changes) },
      });

      return toProfile(row);
    });
  }

  async listSkills(userId: string): Promise<ProviderSkill[]> {
    return (
      await this.uow.query<{
        skill_id: string;
        slug: string;
        name: string;
        level: SkillLevel;
        verified: boolean;
      }>(
        `SELECT ps.skill_id, s.slug, s.name, ps.level, ps.verified
           FROM provider_skills ps
           JOIN skills s ON s.id = ps.skill_id
          WHERE ps.provider_id = $1
          ORDER BY s.name`,
        [userId],
      )
    ).map((row) => ({
      skillId: row.skill_id,
      slug: row.slug,
      name: row.name,
      level: row.level,
      verified: row.verified,
    }));
  }

  async addSkill(
    userId: string,
    input: { skillId: string; level: SkillLevel },
  ): Promise<ProviderSkill[]> {
    await this.uow.withTransaction(async (client) => {
      const profile = await client.query(`SELECT 1 FROM provider_profiles WHERE user_id = $1`, [
        userId,
      ]);
      if (profile.rowCount === 0) {
        throw new BusinessException(ErrorCode.PROFILE_NOT_FOUND);
      }

      const skill = await client.query(`SELECT 1 FROM skills WHERE id = $1`, [input.skillId]);
      if (skill.rowCount === 0) {
        throw new BusinessException(ErrorCode.NOT_FOUND, {
          clientMessage: 'Yetkinlik bulunamadı.',
        });
      }

      const inserted = await client.query(
        `INSERT INTO provider_skills (provider_id, skill_id, level)
         VALUES ($1, $2, $3)
         ON CONFLICT (provider_id, skill_id) DO NOTHING`,
        [userId, input.skillId, input.level],
      );

      if ((inserted.rowCount ?? 0) === 0) {
        throw new BusinessException(ErrorCode.SKILL_ALREADY_ADDED);
      }

      await this.audit.record(client, {
        action: AuditAction.PROVIDER_SKILL_ADDED,
        entityType: 'provider_skill',
        entityId: userId,
        actorUserId: userId,
        // Yetkinlik doğrulaması Faz 3'e ait: burada verilen `verified` değeri her zaman false.
        newValue: { skillId: input.skillId, level: input.level },
      });
    });

    return this.listSkills(userId);
  }

  async removeSkill(userId: string, skillId: string): Promise<void> {
    await this.uow.withTransaction(async (client) => {
      const deleted = await client.query(
        `DELETE FROM provider_skills WHERE provider_id = $1 AND skill_id = $2`,
        [userId, skillId],
      );

      if ((deleted.rowCount ?? 0) === 0) {
        throw new BusinessException(ErrorCode.NOT_FOUND);
      }

      await this.audit.record(client, {
        action: AuditAction.PROVIDER_SKILL_REMOVED,
        entityType: 'provider_skill',
        entityId: userId,
        actorUserId: userId,
        oldValue: { skillId },
      });
    });
  }
}
