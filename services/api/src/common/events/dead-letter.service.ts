import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { Logger } from 'pino';
import { POSTGRES_POOL } from '../database/database.tokens';
import { ROOT_LOGGER } from '../logging/logging.tokens';
import type { FailureClassification } from './event-consumer';

export interface DeadLetterRecord {
  id: string;
  eventId: string;
  eventType: string;
  eventVersion: number;
  consumer: string;
  payload: Record<string, unknown>;
  attemptCount: number;
  failureClassification: FailureClassification;
  failureReason: string;
  firstFailureAt: Date;
  lastFailureAt: Date;
  resolvedAt: Date | null;
  createdAt: Date;
}

/**
 * Dead letter event servisi.
 *
 * Kalıcı hata veya deneme sayısı aşımında event burada saklanır.
 * Operasyonel inceleme için yeterli metadata tutulur; hassas payload
 * içeriği loglanmaz.
 */
@Injectable()
export class DeadLetterService {
  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  async record(input: {
    eventId: string;
    eventType: string;
    eventVersion: number;
    consumer: string;
    payload: Record<string, unknown>;
    attemptCount: number;
    classification: FailureClassification;
    reason: string;
  }): Promise<void> {
    // Mevcut kaydı güncelle veya yeni kayıt oluştur (aynı event + consumer çifti).
    const result = await this.pool.query(
      `INSERT INTO dead_letter_events
         (event_id, event_type, event_version, consumer, payload,
          attempt_count, failure_classification, failure_reason,
          first_failure_at, last_failure_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
       ON CONFLICT (event_id, consumer)
         WHERE resolved_at IS NULL
       DO UPDATE SET
         attempt_count = EXCLUDED.attempt_count,
         failure_classification = EXCLUDED.failure_classification,
         failure_reason = EXCLUDED.failure_reason,
         last_failure_at = now()`,
      [
        input.eventId,
        input.eventType,
        input.eventVersion,
        input.consumer,
        JSON.stringify(input.payload),
        input.attemptCount,
        input.classification,
        input.reason.slice(0, 500),
      ],
    );

    // ON CONFLICT DO UPDATE her zaman rowCount=1 döner, INSERT de öyle; bu yüzden
    // sonucu kontrol etmiyoruz. Ancak beklenmeyen durumlar için log bırakıyoruz.
    if ((result.rowCount ?? 0) === 0) {
      this.logger.warn(
        { eventId: input.eventId, consumer: input.consumer },
        'Dead letter kaydı oluşturulamadı (beklenmeyen)',
      );
    }

    this.logger.error(
      {
        eventId: input.eventId,
        eventType: input.eventType,
        consumer: input.consumer,
        attemptCount: input.attemptCount,
        classification: input.classification,
      },
      'Event dead letter kuyruğuna alındı',
    );
  }

  /** Çözülmemiş DLQ kayıt sayısı (izleme/alarm). */
  async unresolvedCount(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM dead_letter_events WHERE resolved_at IS NULL`,
    );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  }

  /** Consumer bazında çözülmemiş DLQ kayıtları (operasyonel inceleme). */
  async unresolvedByConsumer(): Promise<Array<{ consumer: string; count: number }>> {
    const result = await this.pool.query<{ consumer: string; count: string }>(
      `SELECT consumer, count(*)::text AS count
         FROM dead_letter_events
        WHERE resolved_at IS NULL
        GROUP BY consumer
        ORDER BY count DESC`,
    );
    return result.rows.map((r) => ({ consumer: r.consumer, count: parseInt(r.count, 10) }));
  }

  /** Admin liste görünümü (Faz 10). */
  async list(filter: {
    consumer?: string;
    resolved?: boolean;
    limit: number;
    before?: { createdAt: Date; id: string };
  }): Promise<DeadLetterRecord[]> {
    const result = await this.pool.query<{
      id: string;
      event_id: string;
      event_type: string;
      event_version: number;
      consumer: string;
      payload: Record<string, unknown>;
      attempt_count: number;
      failure_classification: FailureClassification;
      failure_reason: string;
      first_failure_at: Date;
      last_failure_at: Date;
      resolved_at: Date | null;
      created_at: Date;
    }>(
      `SELECT id::text, event_id, event_type, event_version, consumer, payload,
              attempt_count, failure_classification, failure_reason,
              first_failure_at, last_failure_at, resolved_at, created_at
         FROM dead_letter_events
        WHERE ($1::text IS NULL OR consumer = $1)
          AND ($2::boolean IS NULL OR (resolved_at IS NOT NULL) = $2)
          AND ($3::timestamptz IS NULL OR (created_at, id) < ($3, $4::bigint))
        ORDER BY created_at DESC, id DESC
        LIMIT $5`,
      [
        filter.consumer ?? null,
        filter.resolved ?? null,
        filter.before?.createdAt ?? null,
        filter.before?.id ?? null,
        filter.limit,
      ],
    );

    return result.rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      eventType: row.event_type,
      eventVersion: row.event_version,
      consumer: row.consumer,
      payload: row.payload,
      attemptCount: row.attempt_count,
      failureClassification: row.failure_classification,
      failureReason: row.failure_reason,
      firstFailureAt: row.first_failure_at,
      lastFailureAt: row.last_failure_at,
      resolvedAt: row.resolved_at,
      createdAt: row.created_at,
    }));
  }

  /** Operasyonel çözüm: kaydı kapatır. Audit çağıran serviste (aynı transaction'da) yazılır. */
  async resolve(client: PoolClient, id: string): Promise<boolean> {
    const result = await client.query(
      `UPDATE dead_letter_events SET resolved_at = now() WHERE id = $1::bigint AND resolved_at IS NULL`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
