import { Global, Module } from '@nestjs/common';
import { EventConsumerRunner } from './event-consumer-runner';
import { EventDeduplicationService } from './event-deduplication.service';
import { DeadLetterService } from './dead-letter.service';
import { EventMetrics } from './event-metrics';
import { NotificationJobConsumer } from './consumers/notification-job.consumer';
import { AnalyticsExportConsumer } from './consumers/analytics-export.consumer';
import { EVENT_CONSUMERS } from './event-consumer';
import { PubSubSubscriberService } from './pubsub-subscriber.service';

/**
 * Event consumer altyapısı (Faz 9).
 *
 * Consumer registrations burada yapılır. Yeni consumer eklendiğinde
 * `EVENT_CONSUMERS` provider'ına eklenir; runner otomatik olarak bulur.
 *
 * `PubSubSubscriberService`, `OutboxModule`'ün (Global) sunduğu `PUBSUB_CLIENT`'ı
 * kullanarak gerçek Pub/Sub mesajlarını runner'a iletir (bkz. `pubsub-subscriber.service.ts`).
 */
@Global()
@Module({
  providers: [
    EventDeduplicationService,
    DeadLetterService,
    EventMetrics,
    NotificationJobConsumer,
    AnalyticsExportConsumer,
    {
      provide: EVENT_CONSUMERS,
      useFactory: (notification: NotificationJobConsumer, analytics: AnalyticsExportConsumer) => [
        notification,
        analytics,
      ],
      inject: [NotificationJobConsumer, AnalyticsExportConsumer],
    },
    EventConsumerRunner,
    PubSubSubscriberService,
  ],
  exports: [EventConsumerRunner, EventDeduplicationService, DeadLetterService, EventMetrics],
})
export class EventsModule {}
