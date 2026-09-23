import { EventEmitter } from 'node:events';
import { PubSubSubscriberService } from './pubsub-subscriber.service';
import type { EventConsumerRunner } from './event-consumer-runner';
import type { PubSub, Subscription, Message } from '@google-cloud/pubsub';
import type { Logger } from 'pino';
import { ALL_TOPICS, coreSubscriptionNameFor } from './event-topology';

class FakeSubscription extends EventEmitter {
  closed = false;
  exists = jest.fn().mockResolvedValue([true]);
  close = jest.fn().mockImplementation(async () => {
    this.closed = true;
  });
}

function fakeMessage(data: Record<string, unknown> | string): Message {
  const buf = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  return {
    id: 'msg-1',
    data: buf,
    ack: jest.fn(),
    nack: jest.fn(),
  } as unknown as Message;
}

describe('PubSubSubscriberService', () => {
  let runner: jest.Mocked<EventConsumerRunner>;
  let logger: jest.Mocked<Logger>;
  let fakeSubs: Map<string, FakeSubscription>;
  let pubsub: jest.Mocked<PubSub>;

  beforeEach(() => {
    fakeSubs = new Map();

    runner = {
      processEvent: jest.fn(),
    } as unknown as jest.Mocked<EventConsumerRunner>;

    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as unknown as jest.Mocked<Logger>;

    pubsub = {
      subscription: jest.fn().mockImplementation((name: string) => {
        const sub = new FakeSubscription();
        fakeSubs.set(name, sub);
        return sub as unknown as Subscription;
      }),
    } as unknown as jest.Mocked<PubSub>;
  });

  it('PUBSUB_CLIENT null ise hiçbir subscription açılmaz', async () => {
    const service = new PubSubSubscriberService(null, runner, logger);
    await service.onApplicationBootstrap();

    expect(pubsub.subscription).not.toHaveBeenCalled();
  });

  it('her domain topic için bir subscription açılır', async () => {
    const service = new PubSubSubscriberService(pubsub, runner, logger);
    await service.onApplicationBootstrap();

    // Varlık kontrolü de aynı fabrikadan geçer: topic başına iki çağrı beklenir.
    expect(pubsub.subscription).toHaveBeenCalledTimes(ALL_TOPICS.length * 2);
    for (const topic of ALL_TOPICS) {
      expect(pubsub.subscription).toHaveBeenCalledWith(coreSubscriptionNameFor(topic));
    }
  });

  it("geçerli mesaj runner.processEvent'e iletilir ve ACK sonucunda ack() çağrılır", async () => {
    runner.processEvent.mockResolvedValue({ action: 'ACK', reason: 'ok' });
    const service = new PubSubSubscriberService(pubsub, runner, logger);
    await service.onApplicationBootstrap();

    const topic = ALL_TOPICS[0];
    const sub = fakeSubs.get(coreSubscriptionNameFor(topic))!;
    const message = fakeMessage({ eventId: 'evt-1', eventType: 'BookingCreated' });

    sub.emit('message', message);
    await new Promise((resolve) => setImmediate(resolve));

    expect(runner.processEvent).toHaveBeenCalledWith({
      eventId: 'evt-1',
      eventType: 'BookingCreated',
    });
    expect(message.ack).toHaveBeenCalled();
    expect(message.nack).not.toHaveBeenCalled();
  });

  it('NACK sonucunda message.nack() çağrılır', async () => {
    runner.processEvent.mockResolvedValue({ action: 'NACK', reason: 'geçici hata' });
    const service = new PubSubSubscriberService(pubsub, runner, logger);
    await service.onApplicationBootstrap();

    const topic = ALL_TOPICS[0];
    const sub = fakeSubs.get(coreSubscriptionNameFor(topic))!;
    const message = fakeMessage({ eventId: 'evt-2', eventType: 'BookingCreated' });

    sub.emit('message', message);
    await new Promise((resolve) => setImmediate(resolve));

    expect(message.nack).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("bozuk JSON runner'a hiç gitmeden ack() ile atlanır", async () => {
    const service = new PubSubSubscriberService(pubsub, runner, logger);
    await service.onApplicationBootstrap();

    const topic = ALL_TOPICS[0];
    const sub = fakeSubs.get(coreSubscriptionNameFor(topic))!;
    const message = fakeMessage('{ bozuk json');

    sub.emit('message', message);
    await new Promise((resolve) => setImmediate(resolve));

    expect(runner.processEvent).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
  });

  it('subscription error olayı loglanır', async () => {
    const service = new PubSubSubscriberService(pubsub, runner, logger);
    await service.onApplicationBootstrap();

    const topic = ALL_TOPICS[0];
    const sub = fakeSubs.get(coreSubscriptionNameFor(topic))!;
    sub.emit('error', new Error('boom'));

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ topic }),
      'Pub/Sub subscription hatası',
    );
  });

  it("onApplicationShutdown tüm subscription'ları kapatır", async () => {
    const service = new PubSubSubscriberService(pubsub, runner, logger);
    await service.onApplicationBootstrap();

    await service.onApplicationShutdown();

    for (const sub of fakeSubs.values()) {
      expect(sub.close).toHaveBeenCalled();
    }
  });

  // Olmayan bir subscription'a sessizce abone olmak, "event tüketiliyor" görünen
  // ama hiçbir şey tüketmeyen bir servis üretir (Faz 13).
  it('beklenen subscription yoksa boot başarısız olur', async () => {
    const missing = coreSubscriptionNameFor(ALL_TOPICS[1]);
    pubsub.subscription = jest.fn().mockImplementation((name: string) => {
      const sub = new FakeSubscription();
      if (name === missing) {
        sub.exists = jest.fn().mockResolvedValue([false]);
      }
      fakeSubs.set(name, sub);
      return sub as unknown as Subscription;
    }) as unknown as jest.Mocked<PubSub>['subscription'];

    const service = new PubSubSubscriberService(pubsub, runner, logger);

    await expect(service.onApplicationBootstrap()).rejects.toThrow(missing);
  });

  // Geçici bir API arızasında crash-loop'a girmek, çalışan revizyonu da götürürdü.
  it('varlık kontrolü hata verirse yalnızca uyarı yazılır ve boot sürer', async () => {
    pubsub.subscription = jest.fn().mockImplementation(() => {
      const sub = new FakeSubscription();
      sub.exists = jest.fn().mockRejectedValue(new Error('geçici arıza'));
      return sub as unknown as Subscription;
    }) as unknown as jest.Mocked<PubSub>['subscription'];

    const service = new PubSubSubscriberService(pubsub, runner, logger);

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});
