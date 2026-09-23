import { EventEmitter } from 'node:events';
import { PubSubSubscriberService } from './pubsub-subscriber.service';
import type { EventConsumerRunner } from './event-consumer-runner';
import type { PubSub, Subscription, Message } from '@google-cloud/pubsub';
import type { Logger } from 'pino';
import { ALL_TOPICS, coreSubscriptionNameFor } from './event-topology';

class FakeSubscription extends EventEmitter {
  closed = false;
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

  it('PUBSUB_CLIENT null ise hiçbir subscription açılmaz', () => {
    const service = new PubSubSubscriberService(null, runner, logger);
    service.onApplicationBootstrap();

    expect(pubsub.subscription).not.toHaveBeenCalled();
  });

  it('her domain topic için bir subscription açılır', () => {
    const service = new PubSubSubscriberService(pubsub, runner, logger);
    service.onApplicationBootstrap();

    expect(pubsub.subscription).toHaveBeenCalledTimes(ALL_TOPICS.length);
    for (const topic of ALL_TOPICS) {
      expect(pubsub.subscription).toHaveBeenCalledWith(coreSubscriptionNameFor(topic));
    }
  });

  it("geçerli mesaj runner.processEvent'e iletilir ve ACK sonucunda ack() çağrılır", async () => {
    runner.processEvent.mockResolvedValue({ action: 'ACK', reason: 'ok' });
    const service = new PubSubSubscriberService(pubsub, runner, logger);
    service.onApplicationBootstrap();

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
    service.onApplicationBootstrap();

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
    service.onApplicationBootstrap();

    const topic = ALL_TOPICS[0];
    const sub = fakeSubs.get(coreSubscriptionNameFor(topic))!;
    const message = fakeMessage('{ bozuk json');

    sub.emit('message', message);
    await new Promise((resolve) => setImmediate(resolve));

    expect(runner.processEvent).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
  });

  it('subscription error olayı loglanır', () => {
    const service = new PubSubSubscriberService(pubsub, runner, logger);
    service.onApplicationBootstrap();

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
    service.onApplicationBootstrap();

    await service.onApplicationShutdown();

    for (const sub of fakeSubs.values()) {
      expect(sub.close).toHaveBeenCalled();
    }
  });
});
