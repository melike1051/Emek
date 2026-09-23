import { Global, Module } from '@nestjs/common';
import type { PubSub } from '@google-cloud/pubsub';
import type { Logger } from 'pino';
import { EVENT_TRANSPORT, type EventTransport } from './event-transport';
import { LoggingEventTransport } from './logging-event-transport';
import { PubSubEventTransport } from './pubsub-event-transport';
import { OutboxPublisher } from './outbox.publisher';
import { OutboxService } from './outbox.service';
import { ROOT_LOGGER } from '../logging/logging.tokens';
import { AppConfigService } from '../config/app-config.service';
import { PUBSUB_CLIENT, pubSubClientProvider, usesPubSub } from '../events/pubsub-client.provider';

/**
 * ADR-0005/0009 kuralının event transport karşılığı: production'da 'logging'
 * transport'u (yalnızca log, teslim garantisi yok) sessizce kabul edilmez.
 */
export function createEventTransport(
  config: AppConfigService,
  logger: Logger,
  pubsub: PubSub | null,
): EventTransport {
  if (config.env.NODE_ENV === 'production' && !usesPubSub(config)) {
    throw new Error('EVENT_TRANSPORT_TYPE must be pubsub in production');
  }

  if (pubsub !== null) {
    return new PubSubEventTransport(pubsub, logger);
  }

  return new LoggingEventTransport(logger);
}

@Global()
@Module({
  providers: [
    OutboxService,
    OutboxPublisher,
    pubSubClientProvider,
    {
      provide: EVENT_TRANSPORT,
      useFactory: createEventTransport,
      inject: [AppConfigService, ROOT_LOGGER, PUBSUB_CLIENT],
    },
  ],
  exports: [OutboxService, OutboxPublisher, PUBSUB_CLIENT],
})
export class OutboxModule {}
