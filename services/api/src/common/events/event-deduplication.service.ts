import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { POSTGRES_POOL } from '../database/database.tokens';

/**
 * Consumer tarafı durable deduplication (ADR-0010 §3, ADR-0020 §4).
 *
 * Her consumer aynı event_id'yi yalnızca bir kez işler. Tekillik `processed_events`
 * tablosunda `PRIMARY KEY (consumer, event_id)` ile garanti edilir.
 *
 * **İşaretleme, iş etkisiyle aynı transaction'da yapılır** (R-75). `markProcessed`
 * bu yüzden bir `PoolClient` ister: çağıran, işaretlemeyi consumer'ın kendi
 * transaction'ının içine almak zorundadır. Havuzdan ayrı bir bağlantı kullanmak
 * mümkün olsaydı ikisi ayrı commit olurdu ve süreç aralarında çökebilirdi
 * (SIGKILL, OOM, Cloud Run instance eviction): satır kalır, iş etkisi kaybolur,
 * yeniden teslim "duplicate" deyip ACK eder. Event sessizce düşer — DLQ'ya bile
 * girmeden. Tip imzası bu kullanımı mümkün kılmaz.
 *
 * Bunun sonucu olarak telafi edici bir `DELETE` de yoktur: hata durumunda
 * transaction geri alınır, işaret ile iş etkisi **birlikte** yok olur.
 */
@Injectable()
export class EventDeduplicationService {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  /**
   * Event'i bu consumer için işlenmiş olarak kaydeder.
   *
   * @param client İş etkisinin yazıldığı transaction'ın bağlantısı — **zorunlu**.
   * @returns `true` ise event ilk kez işleniyor, `false` ise daha önce işlenmiş
   *          (duplicate) ve consumer çağrılmamalıdır.
   */
  async markProcessed(consumer: string, eventId: string, client: PoolClient): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO processed_events (consumer, event_id)
       VALUES ($1, $2)
       ON CONFLICT (consumer, event_id) DO NOTHING`,
      [consumer, eventId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Bir event'in daha önce işlenip işlenmediğini kontrol eder.
   *
   * Bu yalnızca **gözlem** içindir (test, operasyon). Karar yolu `markProcessed`'in
   * dönüş değeridir: ayrı bir okuma, okuma ile yazma arasında yarış bırakır.
   */
  async isProcessed(consumer: string, eventId: string): Promise<boolean> {
    const result = await this.pool.query<{ event_id: string }>(
      `SELECT event_id FROM processed_events WHERE consumer = $1 AND event_id = $2`,
      [consumer, eventId],
    );
    return result.rows.length > 0;
  }
}
