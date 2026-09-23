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

  // Faz 13'ten beri config katmanı production'da 'logging' transport'u zaten
  // reddediyor. Runtime guard yine de test edilir: iki katman birbirinin yedeğidir
  // ve config'in ileride gevşetilmesi bu güvenceyi sessizce kaldırmamalı.
  it('production + EVENT_TRANSPORT_TYPE=logging (pubsub client yok) fırlatır', () => {
    const config = configWith({ ...baseEnv, ...productionEnv });
    const withLoggingTransport = new AppConfigService({
      ...config.env,
      EVENT_TRANSPORT_TYPE: 'logging',
    });

    expect(() => createEventTransport(withLoggingTransport, logger, null)).toThrow(
      /EVENT_TRANSPORT_TYPE must be pubsub in production/,
    );
  });

  it('config katmanı production + logging kombinasyonunu zaten reddeder', () => {
    expect(() =>
      validateEnv({ ...baseEnv, ...productionEnv, EVENT_TRANSPORT_TYPE: 'logging' }),
    ).toThrow(/EVENT_TRANSPORT_TYPE/);
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
