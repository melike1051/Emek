import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditAction, AuditService } from '../common/audit/audit.service';
import { UnitOfWork } from '../common/database/unit-of-work';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';

export interface AvailabilityWindow {
  id: string;
  startsAt: Date;
  endsAt: Date;
}

export interface AvailabilityException {
  id: string;
  startsAt: Date;
  endsAt: Date;
  reason: string | null;
}

/** PostgreSQL exclusion_violation. */
const EXCLUSION_VIOLATION = '23P01';

function isExclusionViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === EXCLUSION_VIOLATION
  );
}

/**
 * Sağlayıcı müsaitliği.
 *
 * Müsaitlik somut aralıklardır; tekrarlama (RRULE) motoru bilinçli olarak yok
 * (bkz. migration notu). Çakışma engeli veritabanındadır: üst üste binen iki pencere
 * "hangisi geçerli" belirsizliği üretirdi.
 */
@Injectable()
export class AvailabilityService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async list(providerId: string, range: { from: Date; to: Date }): Promise<AvailabilityWindow[]> {
    const rows = await this.uow.query<{ id: string; starts_at: Date; ends_at: Date }>(
      `SELECT id, starts_at, ends_at
         FROM availability
        WHERE provider_id = $1 AND slot && tstzrange($2, $3, '[)')
        ORDER BY starts_at`,
      [providerId, range.from, range.to],
    );

    return rows.map((row) => ({ id: row.id, startsAt: row.starts_at, endsAt: row.ends_at }));
  }

  async add(
    providerId: string,
    window: { startsAt: Date; endsAt: Date },
  ): Promise<AvailabilityWindow> {
    return this.uow.withTransaction(async (client) => {
      let inserted;
      try {
        inserted = await client.query<{ id: string; starts_at: Date; ends_at: Date }>(
          `INSERT INTO availability (provider_id, starts_at, ends_at)
           VALUES ($1, $2, $3)
           RETURNING id, starts_at, ends_at`,
          [providerId, window.startsAt, window.endsAt],
        );
      } catch (error) {
        // Çakışma bir kullanıcı hatasıdır, sistem hatası değil: kodlu yanıta çevrilir.
        if (isExclusionViolation(error)) {
          throw new BusinessException(ErrorCode.BOOKING_CONFLICT, {
            clientMessage: 'Bu zaman aralığı mevcut bir müsaitlik penceresiyle çakışıyor.',
          });
        }
        throw error;
      }

      const row = inserted.rows[0];
      if (row === undefined) {
        throw new Error('müsaitlik penceresi oluşturulamadı');
      }

      await this.audit.record(client, {
        action: AuditAction.AVAILABILITY_ADDED,
        entityType: 'availability',
        entityId: row.id,
        actorUserId: providerId,
        newValue: { startsAt: row.starts_at.toISOString(), endsAt: row.ends_at.toISOString() },
      });

      return { id: row.id, startsAt: row.starts_at, endsAt: row.ends_at };
    });
  }

  async remove(providerId: string, availabilityId: string): Promise<void> {
    await this.uow.withTransaction(async (client) => {
      // Sorgu sahiplikle kapsanır: başka sağlayıcının penceresi silinemez.
      const deleted = await client.query(
        `DELETE FROM availability WHERE id = $1 AND provider_id = $2`,
        [availabilityId, providerId],
      );

      if ((deleted.rowCount ?? 0) === 0) {
        throw new BusinessException(ErrorCode.NOT_FOUND);
      }

      await this.audit.record(client, {
        action: AuditAction.AVAILABILITY_REMOVED,
        entityType: 'availability',
        entityId: availabilityId,
        actorUserId: providerId,
      });
    });
  }

  async addException(
    providerId: string,
    input: { startsAt: Date; endsAt: Date; reason?: string },
  ): Promise<AvailabilityException> {
    const rows = await this.uow.query<{
      id: string;
      starts_at: Date;
      ends_at: Date;
      reason: string | null;
    }>(
      `INSERT INTO availability_exceptions (provider_id, starts_at, ends_at, reason)
       VALUES ($1, $2, $3, $4)
       RETURNING id, starts_at, ends_at, reason`,
      [providerId, input.startsAt, input.endsAt, input.reason ?? null],
    );

    const row = rows[0];
    if (row === undefined) {
      throw new Error('müsaitlik istisnası oluşturulamadı');
    }

    return {
      id: row.id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      reason: row.reason,
    };
  }

  /**
   * Müsaitliği transaction içinde, pencereyi **kilitleyerek** kontrol eder.
   *
   * `FOR SHARE`: kontrol ile rezervasyonun yazılması arasında sağlayıcı pencereyi
   * silemez. Kilit olmadan rezervasyon, beyan edilmiş saatlerin dışına düşebilirdi
   * (TOCTOU — Faz 4 review bulgusu). Çakışma engeli ayrıca EXCLUDE constraint'indedir.
   */
  async isAvailableLocked(
    client: PoolClient,
    providerId: string,
    range: { startsAt: Date; endsAt: Date },
  ): Promise<boolean> {
    const window = await client.query<{ id: string }>(
      `SELECT id FROM availability
        WHERE provider_id = $1 AND slot @> tstzrange($2, $3, '[)')
        LIMIT 1
        FOR SHARE`,
      [providerId, range.startsAt, range.endsAt],
    );

    if (window.rowCount === 0) {
      return false;
    }

    const blocked = await client.query<{ blocked: boolean }>(
      `SELECT (
         EXISTS (
           SELECT 1 FROM availability_exceptions
            WHERE provider_id = $1 AND slot && tstzrange($2, $3, '[)')
         )
         OR EXISTS (
           SELECT 1 FROM bookings
            WHERE provider_id = $1 AND status <> 'CANCELLED'
              AND slot && tstzrange($2, $3, '[)')
         )
       ) AS blocked`,
      [providerId, range.startsAt, range.endsAt],
    );

    return blocked.rows[0]?.blocked !== true;
  }

  /**
   * Sağlayıcı verilen aralıkta müsait mi?
   *
   * Üç koşul: (1) aralığı **tamamen kapsayan** bir müsaitlik penceresi var,
   * (2) kesişen bir istisna yok, (3) çakışan aktif rezervasyon yok.
   * Kapsama kontrolü `@>` ile yapılır: kısmen örtüşen pencere yeterli değildir —
   * hizmetin tamamı müsait saatlerin içinde olmalı.
   */
  async isAvailable(providerId: string, range: { startsAt: Date; endsAt: Date }): Promise<boolean> {
    const rows = await this.uow.query<{ available: boolean }>(
      `SELECT (
         EXISTS (
           SELECT 1 FROM availability
            WHERE provider_id = $1 AND slot @> tstzrange($2, $3, '[)')
         )
         AND NOT EXISTS (
           SELECT 1 FROM availability_exceptions
            WHERE provider_id = $1 AND slot && tstzrange($2, $3, '[)')
         )
         AND NOT EXISTS (
           SELECT 1 FROM bookings
            WHERE provider_id = $1
              AND status <> 'CANCELLED'
              AND slot && tstzrange($2, $3, '[)')
         )
       ) AS available`,
      [providerId, range.startsAt, range.endsAt],
    );

    return rows[0]?.available ?? false;
  }
}
