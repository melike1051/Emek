import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { POSTGRES_POOL } from '../database/database.tokens';

/**
 * Consumer tarafı durable deduplication (ADR-0010 §3).
 *
 * Her consumer aynı event_id'yi yalnızca bir kez işler. Tekillik `processed_events`
 * tablosunda `PRIMARY KEY (consumer, event_id)` ile garanti edilir.
 *
 * `EventConsumerRunner`, `handle()`'ı çağırmadan **önce** ayrı bir bağlantıda
 * `markProcessed` çağırır (bkz. `event-consumer-runner.ts`). `handle()` TRANSIENT hata
 * dönerse kayıt telafi edici bir `DELETE` ile geri alınır (`rollbackDeduplication`); PERMANENT
 * hatada kayıt kasıtlı olarak kalır (DLQ'ya alınan event otomatik yeniden denenmez).
 *
 * Bu, işaretleme ile `handle()` çağrısı **aynı transaction'da değildir** — süreç tam bu
 * ikisi arasında çökerse event kalıcı olarak "işlenmiş" görünür ama hiç işlenmemiş olur
 * (kabul edilen dar bir yarış penceresi; bkz. `docs/research/technical-risks.md`).
 */
@Injectable()
export class EventDeduplicationService {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  /**
   * Event'i işlenmiş olarak kaydetmeye çalışır.
   *
   * @returns `true` ise event ilk kez işleniyor, `false` ise daha önce işlenmiş (duplicate).
   */
  async markProcessed(consumer: string, eventId: string, client?: PoolClient): Promise<boolean> {
    const executor = client ?? this.pool;
    const result = await executor.query(
      `INSERT INTO processed_events (consumer, event_id)
       VALUES ($1, $2)
       ON CONFLICT (consumer, event_id) DO NOTHING`,
      [consumer, eventId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Bir event'in daha önce işlenip işlenmediğini kontrol eder.
   * Consumer runner, handle çağrısından önce bunu kontrol eder.
   */
  async isProcessed(consumer: string, eventId: string): Promise<boolean> {
    const result = await this.pool.query<{ event_id: string }>(
      `SELECT event_id FROM processed_events WHERE consumer = $1 AND event_id = $2`,
      [consumer, eventId],
    );
    return result.rows.length > 0;
  }
}
