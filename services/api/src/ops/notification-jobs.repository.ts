import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { POSTGRES_POOL } from '../common/database/database.tokens';

export type NotificationJobStatus = 'PENDING' | 'SENT' | 'FAILED';

export interface NotificationJobRecord {
  id: string;
  eventId: string;
  eventType: string;
  channel: string;
  recipientUserId: string;
  templateKey: string;
  status: NotificationJobStatus;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  sentAt: Date | null;
}

/**
 * Bildirim işleri (Faz 9'da oluşturulur, Faz 10'da operasyon görünürlüğü kazanır).
 *
 * Gerçek teslimat (push/SMS/email) henüz bağlı değil (ADR: worker sonraki bir
 * fazda eklenecek) — bu repository yalnızca **görünürlük ve manuel yeniden
 * kuyruklama** sağlar; `retry` bir işi tekrar `PENDING`'e döndürür, bir teslim
 * denemesi tetiklemez.
 */
@Injectable()
export class NotificationJobsRepository {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async list(filter: {
    status?: NotificationJobStatus;
    limit: number;
    before?: { createdAt: Date; id: string };
  }): Promise<NotificationJobRecord[]> {
    const result = await this.pool.query<{
      id: string;
      event_id: string;
      event_type: string;
      channel: string;
      recipient_user_id: string;
      template_key: string;
      status: NotificationJobStatus;
      attempts: number;
      last_error: string | null;
      created_at: Date;
      sent_at: Date | null;
    }>(
      `SELECT id::text, event_id, event_type, channel, recipient_user_id, template_key,
              status, attempts, last_error, created_at, sent_at
         FROM notification_jobs
        WHERE ($1::text IS NULL OR status = $1)
          AND ($2::timestamptz IS NULL OR (created_at, id) < ($2, $3::bigint))
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [
        filter.status ?? null,
        filter.before?.createdAt ?? null,
        filter.before?.id ?? null,
        filter.limit,
      ],
    );

    return result.rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      eventType: row.event_type,
      channel: row.channel,
      recipientUserId: row.recipient_user_id,
      templateKey: row.template_key,
      status: row.status,
      attempts: row.attempts,
      lastError: row.last_error,
      createdAt: row.created_at,
      sentAt: row.sent_at,
    }));
  }

  /** Yalnızca `FAILED` bir işi `PENDING`'e döndürür — çift kez "başarılı" işi tekrar kuyruklamaz. */
  async retry(client: PoolClient, id: string): Promise<boolean> {
    const result = await client.query(
      `UPDATE notification_jobs
          SET status = 'PENDING', last_error = NULL
        WHERE id = $1::bigint AND status = 'FAILED'`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
