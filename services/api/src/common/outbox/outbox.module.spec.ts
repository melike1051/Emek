import type { PubSub } from '@google-cloud/pubsub';
import type { Logger } from 'pino';
import { createEventTransport } from './outbox.module';
import { LoggingEventTransport } from './logging-event-transport';
import { PubSubEventTransport } from './pubsub-event-transport';
import { AppConfigService } from '../config/app-config.service';
import { validateEnv } from '../config/env.schema';
import { productionEnvFixture as productionEnv } from '../config/production-env.fixture';

const baseEnv = {
  DATABASE_URL: 'postgres://emek:secret@localhost:5432/emek',
  REDIS_URL: 'redis://localhost:6379',
};

function configWith(env: Record<string, string>): AppConfigService {
  return new AppConfigService(validateEnv(env));
}

describe('createEventTransport', () => {
  const logger = {} as unknown as Logger;
  const fakePubSub = {} as unknown as PubSub;

  it('geliştirmede pubsub client yoksa LoggingEventTransport döner', () => {
    const transport = createEventTransport(configWith(baseEnv), logger, null);
    expect(transport).toBeInstanceOf(LoggingEventTransport);
  });

  it('pubsub client varsa (emulator veya production) PubSubEventTransport döner', () => {
    const transport = createEventTransport(configWith(baseEnv), logger, fakePubSub);
    expect(transport).toBeInstanceOf(PubSubEventTransport);
  });

  it('production + EVENT_TRANSPORT_TYPE=logging (pubsub client yok) fırlatır', () => {
    expect(() =>
      createEventTransport(configWith({ ...baseEnv, ...productionEnv }), logger, null),
    ).toThrow(/EVENT_TRANSPORT_TYPE must be pubsub in production/);
  });

  it('production + EVENT_TRANSPORT_TYPE=pubsub (pubsub client var) fırlatmaz', () => {
    const transport = createEventTransport(
      configWith({ ...baseEnv, ...productionEnv, EVENT_TRANSPORT_TYPE: 'pubsub' }),
      logger,
      fakePubSub,
    );
    expect(transport).toBeInstanceOf(PubSubEventTransport);
  });
});
