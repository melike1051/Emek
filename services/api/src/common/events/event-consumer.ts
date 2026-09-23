/**
 * Event consumer sözleşmesi.
 *
 * Her consumer bu arayüzü uygular: runner, event'i doğruladıktan ve tekilleştirdikten
 * sonra `handle` çağırır. Consumer'ın kendi idempotensi `processed_events` tarafından
 * garanti edilir (ADR-0010 §3); consumer **iş etkisinin** de idempotent olmasından
 * sorumludur (ör. UNIQUE constraint, upsert, guard kontrolü).
 */

/** Hata sınıflandırması: yeniden deneme kararını belirler. */
export enum FailureClassification {
  /** Geçici hata: timeout, ağ arızası, DB contention. Yeniden denenebilir. */
  TRANSIENT = 'TRANSIENT',
  /** Kalıcı hata: bozuk event, desteklenmeyen sürüm, değişmez ihlali. Yeniden denenmez. */
  PERMANENT = 'PERMANENT',
}

/** Consumer'ın handle() sonucu. */
export type ConsumerResult =
  { success: true } | { success: false; classification: FailureClassification; reason: string };

/** Consumer'a teslim edilen olay zarfı. */
export interface ConsumedEvent {
  eventId: string;
  eventType: string;
  eventVersion: number;
  occurredAt: string;
  aggregateType: string;
  aggregateId: string;
  producer: string;
  correlationId: string | null;
  payload: Record<string, unknown>;
}

/**
 * Domain event consumer arayüzü.
 *
 * Her implementasyon:
 * - `consumerName`: consumer başına tekillik anahtarı (`processed_events.consumer`)
 * - `eventTypes`: dinlediği event tipleri
 * - `handle`: iş etkisini yürütür; `ConsumerResult` döner
 */
export interface EventConsumer {
  readonly consumerName: string;
  readonly eventTypes: readonly string[];
  handle(event: ConsumedEvent): Promise<ConsumerResult>;
}

export const EVENT_CONSUMERS = Symbol('EVENT_CONSUMERS');
