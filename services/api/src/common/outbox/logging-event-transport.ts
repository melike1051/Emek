import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { ROOT_LOGGER } from '../logging/logging.tokens';
import type { EventTransport, OutboundEvent } from './event-transport';

/**
 * Faz 2 transport'u: event'i yalnızca loglar.
 *
 * Amacı, outbox mekanizmasının (aynı transaction'da yazma, yeniden deneme, publish
 * işaretleme) Pub/Sub olmadan uçtan uca çalışır ve test edilebilir olmasıdır.
 * Faz 9'da yerini Pub/Sub adapter'ı alır.
 */
@Injectable()
export class LoggingEventTransport implements EventTransport {
  constructor(@Inject(ROOT_LOGGER) private readonly logger: Logger) {}

  async publish(event: OutboundEvent): Promise<void> {
    this.logger.info(
      {
        eventId: event.eventId,
        eventType: event.eventType,
        eventVersion: event.eventVersion,
        subject: event.subject,
      },
      'Domain event published',
    );
  }
}
