import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Logger } from 'pino';
import { ROOT_LOGGER } from '../../logging/logging.tokens';
import {
  FailureClassification,
  type ConsumedEvent,
  type ConsumerResult,
  type EventConsumer,
} from '../event-consumer';

/**
 * Analytics export consumer'ı.
 *
 * Tüm domain event'lerini `analytics_events` tablosuna denormalize eder.
 * Bu tablo Faz 11 BigQuery export pipeline'ının girdisidir.
 *
 * Consumer **tüm** event tiplerini dinler: yeni event tipi eklendiğinde
 * consumer değişikliği gerekmez.
 *
 * İdempotency: `analytics_events.UNIQUE(event_id)` ile aynı event iki kez
 * yazılamaz. `ON CONFLICT DO NOTHING` ile duplicate sessizce atlanır.
 *
 * Yazma, runner'ın verdiği transaction bağlantısında yapılır: tekilleştirme
 * işareti ile bu satır aynı commit'te olmak zorundadır (R-75).
 */

/** Bilinen tüm event tipleri. Yenisi eklendiğinde buraya eklenir. */
const ALL_EVENT_TYPES = [
  'UserRegistered',
  'ProviderProfileSubmitted',
  'IdentityVerified',
  'BookingCreated',
  'BookingMatched',
  'BookingConfirmed',
  'BookingCancelled',
  'ServiceStarted',
  'ServiceCompleted',
  'PaymentAuthorized',
  'PaymentReleased',
  'PaymentRefunded',
  'DisputeOpened',
  'DisputeResolved',
  'ServiceEvidenceAdded',
  'SafetyAlertRaised',
] as const;

@Injectable()
export class AnalyticsExportConsumer implements EventConsumer {
  readonly consumerName = 'analytics-export';
  readonly eventTypes = ALL_EVENT_TYPES;

  constructor(@Inject(ROOT_LOGGER) private readonly logger: Logger) {}

  async handle(event: ConsumedEvent, client: PoolClient): Promise<ConsumerResult> {
    try {
      // event_id UNIQUE: aynı event ikinci kez yazılamaz.
      await client.query(
        `INSERT INTO analytics_events
           (event_id, event_type, event_version, aggregate_type, aggregate_id,
            occurred_at, correlation_id, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (event_id) DO NOTHING`,
        [
          event.eventId,
          event.eventType,
          event.eventVersion,
          event.aggregateType,
          event.aggregateId === '' ? null : event.aggregateId,
          event.occurredAt,
          event.correlationId,
          JSON.stringify(event.payload),
        ],
      );

      return { success: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Bilinmeyen hata';
      return {
        success: false,
        classification: FailureClassification.TRANSIENT,
        reason: reason.slice(0, 500),
      };
    }
  }
}
