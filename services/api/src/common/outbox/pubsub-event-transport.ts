import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PubSub } from '@google-cloud/pubsub';
import type { Logger } from 'pino';
import { ROOT_LOGGER } from '../logging/logging.tokens';
import type { EventTransport, OutboundEvent } from './event-transport';
import { DEFAULT_TOPIC, EVENT_TOPIC_MAP } from '../events/event-topology';

const PUBLISH_TIMEOUT_MS = 10_000;

@Injectable()
export class PubSubEventTransport implements EventTransport, OnModuleDestroy {
  constructor(
    private readonly pubsub: PubSub,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  async publish(event: OutboundEvent): Promise<void> {
    const topicName = EVENT_TOPIC_MAP[event.eventType] ?? DEFAULT_TOPIC;
    const topic = this.pubsub.topic(topicName);

    // ADR-0010: Canonical JSON envelope
    const envelope = {
      producer: 'services/api',
      schemaVersion: 1,
      aggregateType: event.subject.type,
      aggregateId: event.subject.id,
      ...event,
    };

    const data = Buffer.from(JSON.stringify(envelope));
    const orderingKey = `${event.subject.type}:${event.subject.id ?? 'none'}`;

    const attributes = {
      eventType: event.eventType,
      eventVersion: String(event.eventVersion),
      aggregateType: event.subject.type,
      aggregateId: event.subject.id ?? 'none',
    };

    const startTime = Date.now();
    let timeoutId: NodeJS.Timeout | undefined;

    const publishPromise = topic.publishMessage({
      data,
      attributes,
      orderingKey,
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        const error = new Error(`Pub/Sub publish timeout for event ${event.eventId}`);
        error.name = 'PubSubTimeoutError';
        reject(error);
      }, PUBLISH_TIMEOUT_MS);
    });

    try {
      await Promise.race([publishPromise, timeoutPromise]);

      const latency = Date.now() - startTime;
      this.logger.debug(
        { eventId: event.eventId, eventType: event.eventType, topic: topicName, latency },
        'Event published to Pub/Sub',
      );
    } catch (error) {
      const err = new Error(
        `Failed to publish event to Pub/Sub: ${error instanceof Error ? error.message : String(error)}`,
      );
      err.name = error instanceof Error ? error.name : 'PubSubPublishError';
      throw err;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.pubsub.close();
      this.logger.info('Pub/Sub client closed successfully');
    } catch (error) {
      this.logger.error({ err: error }, 'Error closing Pub/Sub client');
    }
  }
}
