import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Logger } from 'pino';
import { ROOT_LOGGER } from '../logging/logging.tokens';
import {
  FailureClassification,
  type ConsumedEvent,
  type EventConsumer,
  EVENT_CONSUMERS,
} from './event-consumer';
import { EventDeduplicationService } from './event-deduplication.service';
import { DeadLetterService } from './dead-letter.service';
import { EventMetrics } from './event-metrics';
import { classifyFailure } from './failure-classifier';

/** Consumer runner'ın desteklediği envelope şema sürümleri. */
const SUPPORTED_SCHEMA_VERSIONS = [1];

/**
 * Event consumer runner (ADR-0010 §3, ADR-0020).
 *
 * Pipeline:
 *   receive event
 *   → validate envelope
 *   → validate event version
 *   → classify failure
 *   → durable deduplication
 *   → execute consumer
 *   → acknowledge (veya nack/DLQ)
 *
 * Bu sınıf **local** çalışma modunu destekler: Pub/Sub subscription
 * listener'ı yerine, outbox publisher tarafından yayınlanan event'leri
 * doğrudan işler. Gerçek Pub/Sub subscription listener ayrı bir modda
 * çalışır.
 *
 * Testler `processEvent()` metodunu doğrudan çağırarak pipeline'ı sınar.
 */
@Injectable()
export class EventConsumerRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly consumersByType = new Map<string, EventConsumer[]>();
  private stopped = false;

  constructor(
    @Inject(EVENT_CONSUMERS) private readonly consumers: EventConsumer[],
    private readonly deduplication: EventDeduplicationService,
    private readonly deadLetter: DeadLetterService,
    private readonly metrics: EventMetrics,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    // Consumer'ları event type'a göre indeksle.
    for (const consumer of this.consumers) {
      for (const eventType of consumer.eventTypes) {
        const existing = this.consumersByType.get(eventType) ?? [];
        existing.push(consumer);
        this.consumersByType.set(eventType, existing);
      }
    }

    this.logger.info(
      {
        consumerCount: this.consumers.length,
        eventTypes: Array.from(this.consumersByType.keys()),
      },
      'Event consumer runner başlatıldı',
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    this.logger.info('Event consumer runner kapatılıyor');
  }

  /**
   * Tek bir event'i pipeline'dan geçirir.
   *
   * Bu metot hem Pub/Sub message handler'ından hem test'lerden çağrılabilir.
   * Dönüş değeri acknowledge/nack kararı için kullanılır.
   */
  async processEvent(raw: unknown): Promise<ProcessEventResult> {
    if (this.stopped) {
      return { action: 'NACK', reason: 'Runner kapatılıyor' };
    }

    // 1. Envelope doğrulama
    const envelope = this.validateEnvelope(raw);
    if (envelope === null) {
      return { action: 'ACK', reason: "Bozuk envelope — DLQ'ya yönlendirildi veya atıldı" };
    }

    // 2. Bu event type'ı dinleyen consumer var mı?
    const matchedConsumers = this.consumersByType.get(envelope.eventType);
    if (matchedConsumers === undefined || matchedConsumers.length === 0) {
      // Bilinen bir event ama dinleyen yok — sorun değil, acknowledge et.
      return { action: 'ACK', reason: 'Dinleyen consumer yok' };
    }

    // 3. Her consumer için pipeline
    const results: ConsumerProcessResult[] = [];
    for (const consumer of matchedConsumers) {
      const result = await this.processForConsumer(consumer, envelope);
      results.push(result);
    }

    // Herhangi bir consumer geçici hata aldıysa NACK (Pub/Sub yeniden dener).
    const hasTransient = results.some((r) => r.outcome === 'TRANSIENT_FAILURE');
    if (hasTransient) {
      return { action: 'NACK', reason: 'Geçici hata — yeniden denenecek' };
    }

    return { action: 'ACK', reason: "Tüm consumer'lar başarılı veya kalıcı hata (DLQ)" };
  }

  private async processForConsumer(
    consumer: EventConsumer,
    envelope: ConsumedEvent,
  ): Promise<ConsumerProcessResult> {
    const start = Date.now();

    // Deduplication kontrolü
    const isNew = await this.deduplication.markProcessed(consumer.consumerName, envelope.eventId);

    if (!isNew) {
      this.metrics.duplicateDetected({
        eventId: envelope.eventId,
        eventType: envelope.eventType,
        consumer: consumer.consumerName,
      });
      return { outcome: 'DUPLICATE' };
    }

    // Consumer'ı çalıştır
    try {
      const result = await consumer.handle(envelope);

      if (result.success) {
        this.metrics.consumerSuccess({
          eventId: envelope.eventId,
          eventType: envelope.eventType,
          consumer: consumer.consumerName,
          latencyMs: Date.now() - start,
        });
        return { outcome: 'SUCCESS' };
      }

      // Consumer başarısızlık bildirdi
      return await this.handleConsumerFailure(
        consumer,
        envelope,
        result.classification,
        result.reason,
      );
    } catch (error) {
      const classification = classifyFailure(error, this.logger);
      const reason = error instanceof Error ? error.message.slice(0, 500) : 'Bilinmeyen hata';
      return await this.handleConsumerFailure(consumer, envelope, classification, reason);
    }
  }

  private async handleConsumerFailure(
    consumer: EventConsumer,
    envelope: ConsumedEvent,
    classification: FailureClassification,
    reason: string,
  ): Promise<ConsumerProcessResult> {
    this.metrics.consumerFailure({
      eventId: envelope.eventId,
      eventType: envelope.eventType,
      consumer: consumer.consumerName,
      classification,
      reason,
    });

    if (classification === FailureClassification.PERMANENT) {
      // Kalıcı hata: DLQ'ya yaz, acknowledge et (yeniden denemek anlamsız).
      await this.deadLetter.record({
        eventId: envelope.eventId,
        eventType: envelope.eventType,
        eventVersion: envelope.eventVersion,
        consumer: consumer.consumerName,
        payload: envelope.payload,
        attemptCount: 1,
        classification,
        reason,
      });

      this.metrics.deadLettered({
        eventId: envelope.eventId,
        eventType: envelope.eventType,
        consumer: consumer.consumerName,
        attemptCount: 1,
        classification,
      });

      // Deduplication kaydını kaldır: DLQ'ya alınan event yeniden denenemez
      // ama operasyonel düzeltme sonrası manuel replay yapılabilir.
      // İşaretli tutmak daha güvenli: replay de markProcessed'dan geçer.
      return { outcome: 'PERMANENT_FAILURE' };
    }

    // Geçici hata: deduplication kaydını sil ki Pub/Sub retry'da tekrar denenebilsin.
    // Bu güvenli çünkü iş etkisi commit edilmedi (hata aldık).
    await this.rollbackDeduplication(consumer.consumerName, envelope.eventId);
    return { outcome: 'TRANSIENT_FAILURE' };
  }

  private async rollbackDeduplication(consumer: string, eventId: string): Promise<void> {
    try {
      await this.deduplication['pool'].query(
        `DELETE FROM processed_events WHERE consumer = $1 AND event_id = $2`,
        [consumer, eventId],
      );
    } catch (error) {
      // Rollback başarısız olursa event bir sonraki denemede duplicate olarak görülür
      // ama bu güvenli yöndür: iş etkisi zaten yürütülmedi.
      this.logger.warn({ consumer, eventId, err: error }, 'Deduplication geri alınamadı');
    }
  }

  private validateEnvelope(raw: unknown): ConsumedEvent | null {
    if (raw === null || typeof raw !== 'object') {
      this.logger.warn({ raw: typeof raw }, 'Geçersiz event: nesne değil');
      return null;
    }

    const data = raw as Record<string, unknown>;

    // Zorunlu alanlar
    const eventId = data['eventId'];
    const eventType = data['eventType'];
    const eventVersion = data['eventVersion'];
    const occurredAt = data['occurredAt'];
    const aggregateType = data['aggregateType'];
    const aggregateId = data['aggregateId'];
    const producer = data['producer'];
    const payload = data['payload'];

    if (
      typeof eventId !== 'string' ||
      typeof eventType !== 'string' ||
      typeof eventVersion !== 'number' ||
      typeof occurredAt !== 'string' ||
      typeof aggregateType !== 'string' ||
      typeof aggregateId !== 'string' ||
      typeof producer !== 'string' ||
      (payload !== null && typeof payload !== 'object')
    ) {
      this.logger.warn(
        { eventId, eventType },
        'Bozuk event envelope — zorunlu alanlar eksik veya yanlış tipte',
      );
      return null;
    }

    // Şema sürümü kontrolü
    const schemaVersion = data['schemaVersion'];
    if (typeof schemaVersion === 'number' && !SUPPORTED_SCHEMA_VERSIONS.includes(schemaVersion)) {
      this.logger.warn({ eventId, schemaVersion }, 'Desteklenmeyen envelope şema sürümü');
      return null;
    }

    return {
      eventId,
      eventType,
      eventVersion,
      occurredAt,
      aggregateType,
      aggregateId,
      producer,
      correlationId: typeof data['correlationId'] === 'string' ? data['correlationId'] : null,
      payload: (payload ?? {}) as Record<string, unknown>,
    };
  }
}

export interface ProcessEventResult {
  action: 'ACK' | 'NACK';
  reason: string;
}

interface ConsumerProcessResult {
  outcome: 'SUCCESS' | 'DUPLICATE' | 'PERMANENT_FAILURE' | 'TRANSIENT_FAILURE';
}
