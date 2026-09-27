import type { PoolClient } from 'pg';

/**
 * Event consumer sözleşmesi.
 *
 * Her consumer bu arayüzü uygular: runner bir transaction açar, `processed_events`
 * işaretini **o transaction'ın içine** yazar ve aynı bağlantıyı `handle`'a geçirir
 * (ADR-0010 §3, ADR-0020 §4-5). İşaret ile iş etkisi tek commit'te olduğu için
 * "işlenmiş göründü ama hiç işlenmedi" durumu mümkün değildir (R-75).
 *
 * Consumer **iş etkisinin** de idempotent olmasından sorumludur (ör. UNIQUE
 * constraint, upsert, guard kontrolü): teslim at-least-once'tır ve geri alınmış
 * bir transaction'dan sonra aynı event yeniden gelir.
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
 * - `handle`: iş etkisini **verilen transaction bağlantısında** yürütür;
 *   `ConsumerResult` döner
 *
 * `handle`, PostgreSQL yazmalarının **tamamını** `client` üzerinden yapmak
 * zorundadır. Havuzdan ikinci bir bağlantı almak iki soruna yol açar: yazma
 * runner'ın transaction'ının dışında kalır (geri alınamaz, tekilleştirme
 * garantisi kaybolur) ve uçuştaki istek sayısı havuz boyutuna ulaştığında havuz
 * kendi kendine kilitlenir (EXP-007, `UnitOfWork.query` yorumu).
 *
 * PostgreSQL **dışındaki** yan etkiler (HTTP çağrısı, GCS yazması, push
 * bildirimi) transaction'la geri alınamaz. Böyle bir consumer, etkiyi kendi
 * içinde idempotent yapmak ya da onu bir outbox/işi kuyruğa alarak PostgreSQL
 * sınırının içinde tutmak zorundadır — bugünkü iki consumer yalnızca tablo yazar.
 */
export interface EventConsumer {
  readonly consumerName: string;
  readonly eventTypes: readonly string[];
  handle(event: ConsumedEvent, client: PoolClient): Promise<ConsumerResult>;
}

export const EVENT_CONSUMERS = Symbol('EVENT_CONSUMERS');
