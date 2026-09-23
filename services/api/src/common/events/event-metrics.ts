import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { ROOT_LOGGER } from '../logging/logging.tokens';

/**
 * Event pipeline observability (yapılandırılmış metrikler).
 *
 * Gerçek Prometheus/OpenTelemetry metrikleri Faz 13 altyapısıyla gelecek;
 * burada structured log olarak yayınlanır — bu loglar log tabanlı metrik
 * platformlarında (Cloud Logging → Monitoring) doğrudan alarm kaynağıdır.
 */
@Injectable()
export class EventMetrics {
  constructor(@Inject(ROOT_LOGGER) private readonly logger: Logger) {}

  /** Outbox → transport publish başarılı. */
  publishSuccess(input: {
    eventId: string;
    eventType: string;
    attempts: number;
    latencyMs: number;
  }): void {
    this.logger.info(
      {
        metric: 'event.publish.success',
        eventId: input.eventId,
        eventType: input.eventType,
        attempts: input.attempts,
        latencyMs: input.latencyMs,
      },
      'Event published successfully',
    );
  }

  /** Outbox → transport publish başarısız. */
  publishFailure(input: {
    eventId: string;
    eventType: string;
    attempts: number;
    errorCode: string;
  }): void {
    this.logger.warn(
      {
        metric: 'event.publish.failure',
        eventId: input.eventId,
        eventType: input.eventType,
        attempts: input.attempts,
        errorCode: input.errorCode,
      },
      'Event publish failed',
    );
  }

  /** Consumer event'i başarıyla işledi. */
  consumerSuccess(input: {
    eventId: string;
    eventType: string;
    consumer: string;
    latencyMs: number;
  }): void {
    this.logger.info(
      {
        metric: 'event.consumer.success',
        eventId: input.eventId,
        eventType: input.eventType,
        consumer: input.consumer,
        latencyMs: input.latencyMs,
      },
      'Event consumed successfully',
    );
  }

  /** Consumer event işleme başarısız. */
  consumerFailure(input: {
    eventId: string;
    eventType: string;
    consumer: string;
    classification: string;
    reason: string;
  }): void {
    this.logger.warn(
      {
        metric: 'event.consumer.failure',
        eventId: input.eventId,
        eventType: input.eventType,
        consumer: input.consumer,
        classification: input.classification,
      },
      'Event consumer failed',
    );
  }

  /** Duplicate event tespit edildi (başarılı deduplication). */
  duplicateDetected(input: { eventId: string; eventType: string; consumer: string }): void {
    this.logger.info(
      {
        metric: 'event.consumer.duplicate',
        eventId: input.eventId,
        eventType: input.eventType,
        consumer: input.consumer,
      },
      'Duplicate event skipped',
    );
  }

  /** Event dead letter kuyruğuna alındı. */
  deadLettered(input: {
    eventId: string;
    eventType: string;
    consumer: string;
    attemptCount: number;
    classification: string;
  }): void {
    this.logger.error(
      {
        metric: 'event.dlq.added',
        eventId: input.eventId,
        eventType: input.eventType,
        consumer: input.consumer,
        attemptCount: input.attemptCount,
        classification: input.classification,
      },
      'Event sent to dead letter queue',
    );
  }

  /** Outbox istatistikleri (periyodik). */
  outboxStats(input: {
    pendingCount: number;
    failedCount: number;
    oldestPendingAgeMs: number | null;
  }): void {
    this.logger.info(
      {
        metric: 'event.outbox.stats',
        pendingCount: input.pendingCount,
        failedCount: input.failedCount,
        oldestPendingAgeMs: input.oldestPendingAgeMs,
      },
      'Outbox statistics',
    );
  }
}
