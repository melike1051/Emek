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
import { UnitOfWork } from '../database/unit-of-work';
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
 *   → transaction aç
 *   → durable deduplication (işaret, **aynı** transaction'da)
 *   → execute consumer (aynı transaction'da)
 *   → commit (işaret + iş etkisi birlikte)
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
    private readonly uow: UnitOfWork,
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

    let attempt: TransactionOutcome;
    try {
      // Tekilleştirme işareti ve iş etkisi **tek** transaction'dadır (R-75):
      // ikisi ayrı commit olsaydı süreç aralarında çökebilir ve event işlenmiş
      // görünüp hiç işlenmemiş olabilirdi. Hata yolunda da telafi edici bir
      // DELETE gerekmez — rollback ikisini birlikte geri alır.
      attempt = await this.uow.withTransaction(async (client) => {
        const isNew = await this.deduplication.markProcessed(
          consumer.consumerName,
          envelope.eventId,
          client,
        );

        if (!isNew) {
          return { kind: 'DUPLICATE' };
        }

        const result = await consumer.handle(envelope, client);
        if (result.success) {
          return { kind: 'SUCCESS' };
        }

        // Başarısızlık bildirimi de transaction'ı geri almalıdır: consumer
        // kısmen yazmış olabilir ve tekilleştirme işareti kalmamalıdır. Bu
        // yüzden `return` değil `throw`.
        throw new ConsumerReportedFailure(result.classification, result.reason);
      });
    } catch (error) {
      if (error instanceof ConsumerReportedFailure) {
        return await this.handleConsumerFailure(
          consumer,
          envelope,
          error.classification,
          error.reason,
        );
      }

      // Fırlatılan hata (consumer'dan, markProcessed'dan veya COMMIT'ten).
      // Hepsinde transaction geri alınmıştır: iş etkisi de işaret de yok.
      const classification = classifyFailure(error, this.logger);
      const reason = error instanceof Error ? error.message.slice(0, 500) : 'Bilinmeyen hata';
      return await this.handleConsumerFailure(consumer, envelope, classification, reason);
    }

    // Metrikler commit'ten **sonra** yayılır: transaction callback'i içinde
    // yayılsaydı, COMMIT'te düşen bir event başarılı raporlanırdı.
    if (attempt.kind === 'DUPLICATE') {
      this.metrics.duplicateDetected({
        eventId: envelope.eventId,
        eventType: envelope.eventType,
        consumer: consumer.consumerName,
      });
      return { outcome: 'DUPLICATE' };
    }

    this.metrics.consumerSuccess({
      eventId: envelope.eventId,
      eventType: envelope.eventType,
      consumer: consumer.consumerName,
      latencyMs: Date.now() - start,
    });
    return { outcome: 'SUCCESS' };
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
      // Kalıcı hata: DLQ kaydı ile tekilleştirme işareti **aynı** transaction'da
      // yazılır. İş etkisi geri alındı ama event artık yeniden denenmemelidir:
      // işaret olmadan, ACK'ten önceki bir çökme aynı kalıcı hatayı tekrar
      // işletirdi. İkisi ayrı yazılsaydı da aralarındaki çökme ya izsiz bir
      // düşüş ya da izi olmayan bir yeniden deneme bırakırdı.
      await this.uow.withTransaction(async (client) => {
        await this.deadLetter.record(
          {
            eventId: envelope.eventId,
            eventType: envelope.eventType,
            eventVersion: envelope.eventVersion,
            consumer: consumer.consumerName,
            payload: envelope.payload,
            attemptCount: 1,
            classification,
            reason,
          },
          client,
        );
        await this.deduplication.markProcessed(consumer.consumerName, envelope.eventId, client);
      });

      this.metrics.deadLettered({
        eventId: envelope.eventId,
        eventType: envelope.eventType,
        consumer: consumer.consumerName,
        attemptCount: 1,
        classification,
      });

      return { outcome: 'PERMANENT_FAILURE' };
    }

    // Geçici hata: yapılacak bir şey yok. Transaction geri alındı, ne iş etkisi
    // ne tekilleştirme işareti kaldı; Pub/Sub yeniden teslim ettiğinde event
    // baştan işlenir.
    return { outcome: 'TRANSIENT_FAILURE' };
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

/**
 * Consumer'ın bildirdiği başarısızlık.
 *
 * `ConsumerResult` ile taşınan hata bilgisi, transaction'ı geri almak için
 * istisnaya çevrilir: `withTransaction` yalnızca fırlatılan hatada ROLLBACK eder.
 */
class ConsumerReportedFailure extends Error {
  constructor(
    readonly classification: FailureClassification,
    readonly reason: string,
  ) {
    super(reason);
    this.name = 'ConsumerReportedFailure';
  }
}

/** Transaction'ın içinden dışarı taşınan sonuç (metrikler commit sonrası yayılır). */
type TransactionOutcome = { kind: 'SUCCESS' } | { kind: 'DUPLICATE' };

interface ConsumerProcessResult {
  outcome: 'SUCCESS' | 'DUPLICATE' | 'PERMANENT_FAILURE' | 'TRANSIENT_FAILURE';
}
