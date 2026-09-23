import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { PubSub, Message, Subscription } from '@google-cloud/pubsub';
import type { Logger } from 'pino';
import { ROOT_LOGGER } from '../logging/logging.tokens';
import { PUBSUB_CLIENT } from './pubsub-client.provider';
import { EventConsumerRunner } from './event-consumer-runner';
import { ALL_TOPICS, coreSubscriptionNameFor } from './event-topology';

/**
 * Pull-based Pub/Sub subscriber (ADR-0020 karar 1).
 *
 * Her domain topic'i (`emek.booking`, `emek.payment`, ...) için **tek** bir subscription
 * açar ve gelen mesajları `EventConsumerRunner.processEvent()`'e iletir. Runner event
 * type'a göre kayıtlı tüm consumer'lara kendi içinde dispatch eder (`events.module.ts`);
 * bu yüzden consumer başına ayrı subscription açılmaz — aksi halde aynı event birden
 * fazla kez teslim edilir ve her consumer kendi subscription'ından bir kez, runner'ın
 * fan-out'undan bir kez daha işlenirdi.
 *
 * `PUBSUB_CLIENT` `null` ise (yerel geliştirmede `LoggingEventTransport` kullanılıyor)
 * bu servis devre dışı kalır: event'ler yalnızca loglanır, hiç tüketilmez. Bu, Faz 2'den
 * beri var olan ve bilinçli olarak korunan bir sınırlamadır (bkz. `logging-event-transport.ts`).
 */
@Injectable()
export class PubSubSubscriberService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly subscriptions: Subscription[] = [];

  constructor(
    @Inject(PUBSUB_CLIENT) private readonly pubsub: PubSub | null,
    private readonly runner: EventConsumerRunner,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.pubsub === null) {
      return;
    }

    for (const topic of ALL_TOPICS) {
      const subscriptionName = coreSubscriptionNameFor(topic);
      const subscription = this.pubsub.subscription(subscriptionName);

      subscription.on('message', (message: Message) => {
        void this.handleMessage(topic, message);
      });
      subscription.on('error', (error: Error) => {
        this.logger.error({ err: error, topic, subscriptionName }, 'Pub/Sub subscription hatası');
      });

      this.subscriptions.push(subscription);
    }

    this.logger.info(
      { topics: ALL_TOPICS, subscriptionCount: this.subscriptions.length },
      'Pub/Sub subscriber başlatıldı',
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(
      this.subscriptions.map((subscription) =>
        subscription.close().catch((error: unknown) => {
          this.logger.warn({ err: error }, 'Pub/Sub subscription kapatılamadı');
        }),
      ),
    );
  }

  private async handleMessage(topic: string, message: Message): Promise<void> {
    let envelope: unknown;
    try {
      envelope = JSON.parse(message.data.toString('utf-8'));
    } catch (error) {
      // Ayrıştırılamayan JSON: runner'ın "bozuk envelope" davranışıyla tutarlı olarak
      // ACK edilip atılır (DLQ'ya yazılmaz — bkz. EventConsumerRunner.validateEnvelope).
      this.logger.warn(
        { err: error, topic, messageId: message.id },
        'Bozuk JSON gövdesi — mesaj atlanıyor',
      );
      message.ack();
      return;
    }

    const result = await this.runner.processEvent(envelope);

    if (result.action === 'ACK') {
      message.ack();
    } else {
      message.nack();
    }
  }
}
