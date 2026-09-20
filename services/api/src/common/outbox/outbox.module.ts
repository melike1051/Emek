import { Global, Module } from '@nestjs/common';
import { EVENT_TRANSPORT } from './event-transport';
import { LoggingEventTransport } from './logging-event-transport';
import { OutboxPublisher } from './outbox.publisher';
import { OutboxService } from './outbox.service';

@Global()
@Module({
  providers: [
    OutboxService,
    OutboxPublisher,
    // Faz 9'da Pub/Sub adapter'ı bu porta bağlanır; domain kodu değişmez (ADR-0010).
    { provide: EVENT_TRANSPORT, useClass: LoggingEventTransport },
  ],
  exports: [OutboxService, OutboxPublisher],
})
export class OutboxModule {}
