import { Injectable } from '@nestjs/common';
import { AuditAction, AuditService } from '../common/audit/audit.service';
import { UnitOfWork } from '../common/database/unit-of-work';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { EventType, OutboxService } from '../common/outbox/outbox.service';
import { UsersRepository } from '../users/users.repository';

/** PostgreSQL check_violation. */
const CHECK_VIOLATION = '23514';

/** Bölge sayısı sınırı trigger'ı bu kodu ve mesajı üretir. */
function isAreaLimitViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === CHECK_VIOLATION &&
    typeof candidate.message === 'string' &&
    candidate.message.includes('hizmet bölgesi')
  );
}

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
  /** Günlük rezervasyon üst sınırı — optimizasyonun kapasite kısıtı (Faz 7). */
  maxDailyBookings: number;
  state: ProviderState;
  createdAt: Date;
  updatedAt: Date;
}

/** Sağlayıcının hizmet verdiği coğrafi bölge. */
export interface ProviderServiceArea {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  active: boolean;
}

/** Sağlayıcının sunduğunu beyan ettiği hizmet. */
export interface ProviderService {
  serviceId: string;
  slug: string;
  name: string;
  active: boolean;
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
  max_daily_bookings: number;
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
    maxDailyBookings: Number(row.max_daily_bookings),
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_PROFILE = `
  SELECT user_id, display_name, bio, experience_years, rating_avg, rating_count,
         max_daily_bookings, state, created_at, updated_at
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
                   max_daily_bookings, state, created_at, updated_at`,
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
    changes: {
      displayName?: string;
      bio?: string;
      experienceYears?: number;
      maxDailyBookings?: number;
    },
  ): Promise<ProviderProfile> {
    return this.uow.withTransaction(async (client) => {
      const updated = await client.query<ProviderRow>(
        `UPDATE provider_profiles
            SET display_name = COALESCE($2, display_name),
                bio = CASE WHEN $3::boolean THEN $4 ELSE bio END,
                experience_years = CASE WHEN $5::boolean THEN $6 ELSE experience_years END,
                max_daily_bookings = COALESCE($7, max_daily_bookings)
          WHERE user_id = $1
          RETURNING user_id, display_name, bio, experience_years, rating_avg, rating_count,
                    max_daily_bookings, state, created_at, updated_at`,
        [
          userId,
          changes.displayName ?? null,
          changes.bio !== undefined,
          changes.bio ?? null,
          changes.experienceYears !== undefined,
          changes.experienceYears ?? null,
          changes.maxDailyBookings ?? null,
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

      // Kapasite ayrı bir eylem olarak kaydedilir: optimizasyonun doğrudan girdisidir
      // ve "profil güncellendi" satırı içinde kaybolmamalı. Aksi hâlde bir sağlayıcı
      // kapasitesini yükseltip işleri alıp geri düşürebilir ve iz yalnızca
      // "bazı alanlar değişti" derdi.
      if (changes.maxDailyBookings !== undefined) {
        await this.audit.record(client, {
          action: AuditAction.PROVIDER_CAPACITY_UPDATED,
          entityType: 'provider_profile',
          entityId: userId,
          actorUserId: userId,
          newValue: { maxDailyBookings: Number(row.max_daily_bookings) },
        });
      }

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

  /**
   * Sağlayıcının sunduğu hizmetler.
   *
   * Yetkinlik (`provider_skills`) ile hizmet (`provider_services`) farklı şeylerdir
   * ve karıştırılmamalıdır: yetkinlik "ne yapabiliyor", hizmet "neyi satıyor"
   * sorusunun cevabıdır. Aday havuzu **hizmetten** başlar; yetkinlik hard
   * constraint olarak sonra devreye girer (ADR-0007 §4).
   */
  async listServices(userId: string): Promise<ProviderService[]> {
    const rows = await this.uow.query<{
      service_id: string;
      slug: string;
      name: string;
      active: boolean;
    }>(
      `SELECT ps.service_id, s.slug, s.name, ps.active
         FROM provider_services ps
         JOIN services s ON s.id = ps.service_id
        WHERE ps.provider_id = $1
        ORDER BY s.name`,
      [userId],
    );

    return rows.map((row) => ({
      serviceId: row.service_id,
      slug: row.slug,
      name: row.name,
      active: row.active,
    }));
  }

  async addService(userId: string, serviceId: string): Promise<ProviderService[]> {
    await this.uow.withTransaction(async (client) => {
      const profile = await client.query(`SELECT 1 FROM provider_profiles WHERE user_id = $1`, [
        userId,
      ]);
      if (profile.rowCount === 0) {
        throw new BusinessException(ErrorCode.PROFILE_NOT_FOUND);
      }

      // Yalnızca aktif katalog hizmeti eklenebilir: pasife alınmış bir hizmeti
      // sunduğunu beyan etmek, rezervasyona kapalı bir hizmet için aday olmak demek.
      const service = await client.query(`SELECT 1 FROM services WHERE id = $1 AND active`, [
        serviceId,
      ]);
      if (service.rowCount === 0) {
        throw new BusinessException(ErrorCode.NOT_FOUND, { clientMessage: 'Hizmet bulunamadı.' });
      }

      const inserted = await client.query(
        `INSERT INTO provider_services (provider_id, service_id)
         VALUES ($1, $2)
         ON CONFLICT (provider_id, service_id) DO NOTHING`,
        [userId, serviceId],
      );

      if ((inserted.rowCount ?? 0) === 0) {
        throw new BusinessException(ErrorCode.PROVIDER_SERVICE_ALREADY_ADDED);
      }

      await this.audit.record(client, {
        action: AuditAction.PROVIDER_SERVICE_ADDED,
        entityType: 'provider_service',
        entityId: userId,
        actorUserId: userId,
        newValue: { serviceId },
      });
    });

    return this.listServices(userId);
  }

  async removeService(userId: string, serviceId: string): Promise<void> {
    await this.uow.withTransaction(async (client) => {
      const deleted = await client.query(
        `DELETE FROM provider_services WHERE provider_id = $1 AND service_id = $2`,
        [userId, serviceId],
      );

      if ((deleted.rowCount ?? 0) === 0) {
        throw new BusinessException(ErrorCode.NOT_FOUND);
      }

      await this.audit.record(client, {
        action: AuditAction.PROVIDER_SERVICE_REMOVED,
        entityType: 'provider_service',
        entityId: userId,
        actorUserId: userId,
        oldValue: { serviceId },
      });
    });
  }

  /**
   * Sağlayıcının hizmet bölgeleri.
   *
   * Aday havuzunun coğrafi kapısı budur (Faz 7): bölgesi adresi kapsamayan sağlayıcı
   * hiç aday olmaz ve GIST indeksli sorgu bu tabloyu sürücü olarak kullanır.
   */
  async listServiceAreas(userId: string): Promise<ProviderServiceArea[]> {
    const rows = await this.uow.query<{
      id: string;
      name: string;
      latitude: number;
      longitude: number;
      radius_meters: number;
      active: boolean;
    }>(
      `SELECT id, name,
              ST_Y(ST_Centroid(area::geometry)) AS latitude,
              ST_X(ST_Centroid(area::geometry)) AS longitude,
              radius_meters, active
         FROM provider_service_areas
        WHERE provider_id = $1
        ORDER BY name`,
      [userId],
    );

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      radiusMeters: Number(row.radius_meters),
      active: row.active,
    }));
  }

  /**
   * Merkez + yarıçaptan hizmet bölgesi oluşturur.
   *
   * Girdi olarak **serbest poligon alınmaz**. Gerekçe: kendini kesen veya ters
   * yönlü bir poligon, GIST sorgusunu sessizce yanlış sonuç verdirir ve
   * `ST_IsValid` CHECK'i isteği çalışma zamanında düşürür. Daire, istemciden
   * gelebilecek en basit ve her zaman geçerli geometridir; birbirine değmeyen
   * bölgeler **birden fazla kayıtla** ifade edilir (migration notu).
   *
   * Serbest poligon içe aktarımı operasyon aracıdır ve Faz 10'a aittir.
   */
  async addServiceArea(
    userId: string,
    input: { name: string; latitude: number; longitude: number; radiusMeters: number },
  ): Promise<ProviderServiceArea> {
    return this.uow.withTransaction(async (client) => {
      const profile = await client.query(`SELECT 1 FROM provider_profiles WHERE user_id = $1`, [
        userId,
      ]);
      if (profile.rowCount === 0) {
        throw new BusinessException(ErrorCode.PROFILE_NOT_FOUND);
      }

      let inserted;
      try {
        inserted = await client.query<{ id: string }>(
          `INSERT INTO provider_service_areas (provider_id, name, area, radius_meters)
           VALUES ($1, $2,
                   ST_Multi(
                     ST_Buffer(ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography, $5)::geometry
                   )::geography,
                   $5)
           RETURNING id`,
          [userId, input.name, input.latitude, input.longitude, input.radiusMeters],
        );
      } catch (error) {
        // Bölge sayısı sınırı bir **kullanıcı hatasıdır**, sistem hatası değil:
        // ham trigger hatası 500'e dönüşseydi sağlayıcı ne yapması gerektiğini
        // anlayamazdı.
        if (isAreaLimitViolation(error)) {
          throw new BusinessException(ErrorCode.PROVIDER_SERVICE_AREA_LIMIT);
        }
        throw error;
      }

      const row = inserted.rows[0];
      if (row === undefined) {
        throw new Error('hizmet bölgesi oluşturulamadı');
      }

      await this.audit.record(client, {
        action: AuditAction.SERVICE_AREA_CREATED,
        entityType: 'provider_service_area',
        entityId: row.id,
        actorUserId: userId,
        // Bölgenin **varlığı** kaydedilir, koordinatları değil (ADR-0013 §10).
        newValue: { name: input.name, radiusMeters: input.radiusMeters },
      });

      return {
        id: row.id,
        name: input.name,
        latitude: input.latitude,
        longitude: input.longitude,
        radiusMeters: input.radiusMeters,
        active: true,
      };
    });
  }

  async removeServiceArea(userId: string, areaId: string): Promise<void> {
    await this.uow.withTransaction(async (client) => {
      const deleted = await client.query(
        `DELETE FROM provider_service_areas WHERE id = $1 AND provider_id = $2`,
        [areaId, userId],
      );

      if ((deleted.rowCount ?? 0) === 0) {
        throw new BusinessException(ErrorCode.NOT_FOUND);
      }

      // Bölge silmek aday havuzunu daraltır ve mesafe referans noktasını değiştirir:
      // ekleme kaydediliyorsa silme de kaydedilmeli, yoksa iz tek yönlü kalır.
      await this.audit.record(client, {
        action: AuditAction.SERVICE_AREA_REMOVED,
        entityType: 'provider_service_area',
        entityId: areaId,
        actorUserId: userId,
      });
    });
  }
}
