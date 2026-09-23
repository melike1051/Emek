import { Injectable } from '@nestjs/common';
import type { AnalyticsEventRow, BigQueryInsertResult, BigQueryPort } from './bigquery.port';

/**
 * Bellek-içi BigQuery sahte sağlayıcısı (yerel geliştirme + testler).
 *
 * Gerçek BigQuery gibi `insertId` (burada `eventId`) tekrarını sessizce
 * yutar — testler idempotency'yi bu davranışa göre doğrular.
 */
@Injectable()
export class MockBigQueryAdapter implements BigQueryPort {
  readonly name = 'mock';

  /** table -> eventId -> row. Testler doğrudan okuyabilir. */
  readonly tables = new Map<string, Map<string, AnalyticsEventRow>>();

  /** Test kancası: sonraki `insertRows` çağrısını başarısız kıl (geçici sağlayıcı hatası simülasyonu). */
  failNextInsert = false;

  async insertRows(table: string, rows: AnalyticsEventRow[]): Promise<BigQueryInsertResult> {
    if (this.failNextInsert) {
      this.failNextInsert = false;
      throw new Error('mock bigquery insert failure (test injected)');
    }

    let bucket = this.tables.get(table);
    if (bucket === undefined) {
      bucket = new Map();
      this.tables.set(table, bucket);
    }
    for (const row of rows) {
      bucket.set(row.eventId, row);
    }
    return { rejectedEventIds: [] };
  }

  reset(): void {
    this.tables.clear();
    this.failNextInsert = false;
  }
}
