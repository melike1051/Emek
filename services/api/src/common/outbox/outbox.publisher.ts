import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Logger } from 'pino';
import type { Pool } from 'pg';
import { POSTGRES_POOL } from '../database/database.tokens';
import { ROOT_LOGGER } from '../logging/logging.tokens';
import { EVENT_TRANSPORT, type EventTransport, type OutboundEvent } from './event-transport';

interface OutboxRow {
  event_id: string;
  event_type: string;
  event_version: number;
  subject_type: string;
  subject_id: string | null;
  payload: Record<string, unknown>;
  correlation_id: string | null;
  occurred_at: Date;
  attempts: number;
}

export const OUTBOX_BATCH_SIZE = 50;
export const OUTBOX_POLL_INTERVAL_MS = 1000;
/** Bu sayıdan sonra kayıt FAILED'a alınır ve alarm konusu olur (DLQ topolojisi Faz 9). */
export const OUTBOX_MAX_ATTEMPTS = 10;
/** Sahiplenilen kaydın başka instance tarafından alınamayacağı süre. */
export const CLAIM_LEASE_SECONDS = 30;
/** Tek bir drain turunda işlenecek azami batch sayısı. */
export const MAX_ROUNDS_PER_DRAIN = 100;

/**
 * Outbox'ta bekleyen event'leri transport'a taşır.
 *
 * Teslim **at-least-once**'tır: transport başarılı olup işaretleme başarısız olursa
 * event tekrar yayınlanır. Bu yüzden tüketiciler `event_id` ile idempotenttir (ADR-0010 §3).
 *
 * Kayıtlar **atomik olarak sahiplenilir**: tek bir `UPDATE ... WHERE event_id IN
 * (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING` ifadesi hem kilidi hem sahiplenmeyi
 * aynı ifade içinde yapar ve `next_attempt_at`'i ileri atar. Ayrı bir SELECT ile kilit
 * almak işe yaramazdı: havuz üzerinden çalışan bir SELECT kendi implicit transaction'ı
 * bittiğinde kilidi bırakır ve iki instance aynı event'i gönderebilirdi.
 */
@Injectable()
export class OutboxPublisher implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    @Inject(EVENT_TRANSPORT) private readonly transport: EventTransport,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    this.schedule();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
  }

  private schedule(): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.drain()
        .catch((error: unknown) => {
          this.logger.error({ err: error }, 'Outbox publisher turu başarısız');
        })
        .finally(() => this.schedule());
    }, OUTBOX_POLL_INTERVAL_MS);
    this.timer.unref();
  }

  /** Bekleyen kayıtları işler ve yayınlanan event sayısını döner. Testler bunu doğrudan çağırır. */
  async drain(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;

    try {
      let published = 0;
      // Tur başına üst sınır: sürekli hata veren bir transport, publisher'ı sonsuz
      // döngüde tutup diğer işleri aç bırakmamalı.
      for (let round = 0; round < MAX_ROUNDS_PER_DRAIN; round += 1) {
        const batch = await this.claimBatch();
        if (batch.length === 0) {
          return published;
        }
        for (const row of batch) {
          if (await this.dispatch(row)) {
            published += 1;
          }
        }
      }
      return published;
    } finally {
      this.running = false;
    }
  }

  private async claimBatch(): Promise<OutboxRow[]> {
    // Sahiplenme ve görünürlük tek ifadede: sahiplenilen kayıtlar `CLAIM_LEASE_SECONDS`
    // boyunca başka bir instance tarafından alınamaz. Süre dolarsa (instance çöktü)
    // kayıt kendiliğinden yeniden sahiplenilebilir hale gelir — event kaybolmaz.
    const result = await this.pool.query<OutboxRow>(
      `UPDATE outbox
          SET next_attempt_at = now() + ($2 || ' seconds')::interval
        WHERE event_id IN (
          SELECT event_id
            FROM outbox
           WHERE status = 'PENDING'
             AND next_attempt_at <= now()
           ORDER BY occurred_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING event_id, event_type, event_version, subject_type, subject_id,
                  payload, correlation_id, occurred_at, attempts`,
      [OUTBOX_BATCH_SIZE, String(CLAIM_LEASE_SECONDS)],
    );

    return result.rows;
  }

  private async dispatch(row: OutboxRow): Promise<boolean> {
    const event: OutboundEvent = {
      eventId: row.event_id,
      eventType: row.event_type,
      eventVersion: row.event_version,
      occurredAt: row.occurred_at,
      subject: { type: row.subject_type, id: row.subject_id },
      correlationId: row.correlation_id,
      payload: row.payload,
    };

    try {
      await this.transport.publish(event);
    } catch (error) {
      await this.markFailure(row, error);
      return false;
    }

    await this.pool.query(
      `UPDATE outbox SET status = 'PUBLISHED', published_at = now(), attempts = attempts + 1
        WHERE event_id = $1`,
      [row.event_id],
    );
    return true;
  }

  private async markFailure(row: OutboxRow, error: unknown): Promise<void> {
    const attempts = row.attempts + 1;
    // Deneme hakkı bitince kayıt FAILED olur ve **bir daha alınmaz** (claim sorgusu
    // yalnızca PENDING okur). FAILED kayıtlar operasyonel inceleme konusudur;
    // DLQ topolojisi ve alarmı Faz 9'da gelir.
    const exhausted = attempts >= OUTBOX_MAX_ATTEMPTS;
    // Yalnızca sınıflandırılmış kod saklanır: hata metni payload/PII sızdırabilir.
    const errorCode = error instanceof Error ? error.name : 'UnknownError';
    // Exponential backoff, üst sınırla.
    const backoffSeconds = Math.min(2 ** attempts, 300);

    await this.pool.query(
      `UPDATE outbox
          SET attempts = $2,
              last_error_code = $3,
              status = CASE WHEN $4 THEN 'FAILED'::outbox_status ELSE 'PENDING'::outbox_status END,
              next_attempt_at = now() + ($5 || ' seconds')::interval
        WHERE event_id = $1`,
      [row.event_id, attempts, errorCode.slice(0, 80), exhausted, String(backoffSeconds)],
    );

    this.logger.warn(
      { eventId: row.event_id, eventType: row.event_type, attempts, exhausted },
      'Outbox event yayınlanamadı',
    );
  }
}
