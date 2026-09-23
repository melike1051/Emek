import { PubSubEventTransport } from './pubsub-event-transport';
import type { PubSub, Topic } from '@google-cloud/pubsub';
import type { Logger } from 'pino';
import type { OutboundEvent } from './event-transport';

interface PublishMessageArgs {
  data: Buffer;
  attributes: Record<string, string>;
  orderingKey: string;
}

describe('PubSubEventTransport', () => {
  let transport: PubSubEventTransport;
  let pubsub: jest.Mocked<PubSub>;
  let mockTopic: jest.Mocked<Topic>;
  let logger: jest.Mocked<Logger>;

  const testEvent: OutboundEvent = {
    eventId: 'evt-123',
    eventType: 'BookingCreated',
    eventVersion: 1,
    subject: { type: 'Booking', id: 'b-1' },
    occurredAt: new Date('2026-01-01T00:00:00Z'),
    correlationId: null,
    payload: { details: 'test' },
  };

  beforeEach(() => {
    mockTopic = {
      publishMessage: jest.fn().mockResolvedValue('msg-id-123'),
    } as unknown as jest.Mocked<Topic>;

    pubsub = {
      topic: jest.fn().mockReturnValue(mockTopic),
      close: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<PubSub>;

    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as unknown as jest.Mocked<Logger>;

    transport = new PubSubEventTransport(pubsub, logger);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('event başarılı şekilde doğru topic ile yayınlanır', async () => {
    await transport.publish(testEvent);

    expect(pubsub.topic).toHaveBeenCalledWith('emek.booking');
    expect(mockTopic.publishMessage).toHaveBeenCalled();
  });

  it('doğru envelope (zarf) yapısı oluşturulur', async () => {
    await transport.publish(testEvent);

    const callArgs = mockTopic.publishMessage.mock.calls[0]?.[0] as PublishMessageArgs;
    const dataObj = JSON.parse(callArgs.data.toString());

    expect(dataObj).toEqual(
      expect.objectContaining({
        producer: 'services/api',
        schemaVersion: 1,
        aggregateType: 'Booking',
        aggregateId: 'b-1',
        eventId: 'evt-123',
        eventType: 'BookingCreated',
        eventVersion: 1,
      }),
    );
  });

  it('doğru mesaj öznitelikleri (attributes) ayarlanır', async () => {
    await transport.publish(testEvent);

    const callArgs = mockTopic.publishMessage.mock.calls[0]?.[0] as PublishMessageArgs;
    expect(callArgs.attributes).toEqual({
      eventType: 'BookingCreated',
      eventVersion: '1',
      aggregateType: 'Booking',
      aggregateId: 'b-1',
    });
  });

  it('doğru orderingKey formatı kullanılır', async () => {
    await transport.publish(testEvent);

    const callArgs = mockTopic.publishMessage.mock.calls[0]?.[0] as PublishMessageArgs;
    expect(callArgs.orderingKey).toBe('Booking:b-1');
  });

  it('publish zaman aşımına uğrarsa hata fırlatılır', async () => {
    jest.useFakeTimers();

    mockTopic.publishMessage.mockImplementation(
      () =>
        new Promise<string>(() => {
          /* asla çözülmez */
        }),
    );

    const publishPromise = transport.publish(testEvent);
    jest.advanceTimersByTime(11_000);

    await expect(publishPromise).rejects.toThrow(/Pub\/Sub publish timeout/);
  });

  it('publish hatası fırlatılırsa error name korunur', async () => {
    const pubsubError = new Error('GCP Error');
    pubsubError.name = 'GoogleError';
    (mockTopic.publishMessage as jest.Mock).mockRejectedValue(pubsubError);

    try {
      await transport.publish(testEvent);
      fail('should have thrown');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('GoogleError');
      expect((error as Error).message).toContain('GCP Error');
    }
  });

  it('module destroy çağrıldığında pubsub.close çağrılır', async () => {
    await transport.onModuleDestroy();
    expect(pubsub.close).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Pub/Sub client closed successfully');
  });
});
