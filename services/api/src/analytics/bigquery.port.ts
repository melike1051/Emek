/**
 * BigQuery export portu (Faz 11, ADR-0021).
 *
 * Core backend somut bir BigQuery client'ı tanımaz. Gerçek bağlantı
 * `bigquery-client.adapter.ts`'te, testler ve yerel geliştirme için
 * bellek-içi bir sahte `mock-bigquery-adapter.ts`'tedir — tıpkı
 * `PaymentProvider`/`IdentityVerificationProvider` portlarında olduğu gibi.
 *
 * BigQuery yalnızca analitik hedeftir: bu port asla bir yazma işleminin
 * transactional doğruluğunu etkilemez, yalnızca `analytics_events`'in
 * (PostgreSQL, kaynak doğruluk) bir kopyasını taşır.
 */

/** BigQuery'ye yazılacak tek bir ham event satırı (bronze layer). */
export interface AnalyticsEventRow {
  eventId: string;
  eventType: string;
  eventVersion: number;
  aggregateType: string;
  aggregateId: string | null;
  occurredAt: Date;
  correlationId: string | null;
  /** Event zarfının payload'ı — zaten PII taşımaz (event-catalog.md §1). */
  payload: Record<string, unknown>;
}

export interface BigQueryInsertResult {
  /** Sağlayıcı tarafından reddedilen (şema/tip hatası) satırların event id'leri. */
  rejectedEventIds: string[];
}

export interface BigQueryPort {
  readonly name: string;
  /**
   * Satırları hedef tabloya ekler. Idempotency `insertId = eventId` ile
   * BigQuery streaming insert'in en-az-bir-kez-dedupe-best-effort davranışına
   * bırakılır; **kesin** idempotency kaynağı PostgreSQL'deki `exported_at`
   * işaretidir (bu satır bir kez başarıyla yazıldıktan sonra bir daha
   * gönderilmez — ADR-0021 §4).
   */
  insertRows(table: string, rows: AnalyticsEventRow[]): Promise<BigQueryInsertResult>;
}

export const BIGQUERY_PORT = Symbol('BIGQUERY_PORT');

export class BigQueryPortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BigQueryPortError';
  }
}
