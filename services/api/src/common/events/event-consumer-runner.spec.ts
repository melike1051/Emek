import { EventConsumerRunner } from './event-consumer-runner';
import { FailureClassification, type EventConsumer } from './event-consumer';
import type { EventDeduplicationService } from './event-deduplication.service';
import type { DeadLetterService } from './dead-letter.service';
import type { EventMetrics } from './event-metrics';
import type { Logger } from 'pino';
import type { PoolClient } from 'pg';
import type { UnitOfWork } from '../database/unit-of-work';

describe('EventConsumerRunner', () => {
  let runner: EventConsumerRunner;
  let dedup: jest.Mocked<EventDeduplicationService>;
  let uow: jest.Mocked<UnitOfWork>;
  let client: PoolClient;
  /** COMMIT'te düşen transaction'ı taklit etmek için. */
  let commitFails: boolean;
  let dlq: jest.Mocked<DeadLetterService>;
  let metrics: jest.Mocked<EventMetrics>;
  let logger: jest.Mocked<Logger>;

  let consumer1: jest.Mocked<EventConsumer>;
  let consumer2: jest.Mocked<EventConsumer>;

  const validEnvelope = {
    eventId: 'evt-123',
    eventType: 'TestEvent',
    eventVersion: 1,
    schemaVersion: 1,
    occurredAt: '2026-01-01T00:00:00Z',
    aggregateType: 'test',
    aggregateId: 'agg-123',
    producer: 'test-producer',
    correlationId: null,
    payload: { foo: 'bar' },
  };

  beforeEach(() => {
    dedup = {
      markProcessed: jest.fn().mockResolvedValue(true),
      isProcessed: jest.fn().mockResolvedValue(false),
    } as unknown as jest.Mocked<EventDeduplicationService>;

    client = { query: jest.fn().mockResolvedValue({ rowCount: 1 }) } as unknown as PoolClient;
    commitFails = false;

    // Gerçek `UnitOfWork` gibi davranır: callback fırlatırsa hata yukarı çıkar
    // (ROLLBACK). Rollback'in gerçekten satırları geri aldığı entegrasyon
    // testlerinde, gerçek Postgres'e karşı doğrulanır.
    uow = {
      withTransaction: jest.fn(async (work: (c: PoolClient) => Promise<unknown>) => {
        const result = await work(client);
        if (commitFails) {
          throw new Error('COMMIT başarısız');
        }
        return result;
      }),
    } as unknown as jest.Mocked<UnitOfWork>;

    dlq = {
      record: jest.fn().mockResolvedValue(undefined),
      unresolvedCount: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<DeadLetterService>;

    metrics = {
      publishSuccess: jest.fn(),
      publishFailure: jest.fn(),
      consumerSuccess: jest.fn(),
      consumerFailure: jest.fn(),
      duplicateDetected: jest.fn(),
      deadLettered: jest.fn(),
      outboxStats: jest.fn(),
    } as unknown as jest.Mocked<EventMetrics>;

    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      child: jest.fn().mockReturnThis(),
    } as unknown as jest.Mocked<Logger>;

    consumer1 = {
      consumerName: 'test-consumer-1',
      eventTypes: ['TestEvent'],
      handle: jest.fn().mockResolvedValue({ success: true }),
    };

    consumer2 = {
      consumerName: 'test-consumer-2',
      eventTypes: ['TestEvent', 'OtherEvent'],
      handle: jest.fn().mockResolvedValue({ success: true }),
    };
  });

  const createRunner = (consumers: EventConsumer[]) => {
    const r = new EventConsumerRunner(consumers, uow, dedup, dlq, metrics, logger);
    r.onApplicationBootstrap();
    return r;
  };

  it('geçerli event eşleşen consumer ile işlenir ve ACK döner', async () => {
    runner = createRunner([consumer1]);

    const result = await runner.processEvent(validEnvelope);

    expect(result.action).toBe('ACK');
    // İşaret ve iş etkisi aynı transaction bağlantısındadır (R-75).
    expect(dedup.markProcessed).toHaveBeenCalledWith('test-consumer-1', 'evt-123', client);
    expect(consumer1.handle).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt-123', eventType: 'TestEvent' }),
      client,
    );
    expect(uow.withTransaction).toHaveBeenCalledTimes(1);
    expect(metrics.consumerSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt-123', consumer: 'test-consumer-1' }),
    );
  });

  it('mükerrer event tespit edilirse atlanır ve ACK döner', async () => {
    dedup.markProcessed.mockResolvedValue(false); // Zaten işlenmiş
    runner = createRunner([consumer1]);

    const result = await runner.processEvent(validEnvelope);

    expect(result.action).toBe('ACK');
    expect(consumer1.handle).not.toHaveBeenCalled();
    expect(metrics.duplicateDetected).toHaveBeenCalledWith({
      eventId: 'evt-123',
      eventType: 'TestEvent',
      consumer: 'test-consumer-1',
    });
  });

  it('eşleşen consumer yoksa ACK döner', async () => {
    runner = createRunner([consumer1]);

    const result = await runner.processEvent({ ...validEnvelope, eventType: 'UnknownEvent' });

    expect(result.action).toBe('ACK');
    expect(result.reason).toContain('Dinleyen consumer yok');
    expect(consumer1.handle).not.toHaveBeenCalled();
  });

  it('bozuk envelope (eksik alanlar) için ACK döner', async () => {
    runner = createRunner([consumer1]);

    const result = await runner.processEvent({ eventId: 'evt-123' });

    expect(result.action).toBe('ACK');
    expect(result.reason).toContain('Bozuk envelope');
  });

  it('null envelope için ACK döner', async () => {
    runner = createRunner([consumer1]);

    const result = await runner.processEvent(null);

    expect(result.action).toBe('ACK');
  });

  it('desteklenmeyen şema sürümü için ACK döner', async () => {
    runner = createRunner([consumer1]);

    const result = await runner.processEvent({ ...validEnvelope, schemaVersion: 99 });

    expect(result.action).toBe('ACK');
  });

  it('consumer kalıcı (PERMANENT) hata dönerse DLQ kaydı oluşturulur ve ACK döner', async () => {
    consumer1.handle.mockResolvedValue({
      success: false,
      classification: FailureClassification.PERMANENT,
      reason: 'Validation failed',
    });
    runner = createRunner([consumer1]);

    const result = await runner.processEvent(validEnvelope);

    expect(result.action).toBe('ACK');
    expect(dlq.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'evt-123',
        consumer: 'test-consumer-1',
        classification: FailureClassification.PERMANENT,
        reason: 'Validation failed',
      }),
      client,
    );
    expect(metrics.deadLettered).toHaveBeenCalled();
  });

  it('consumer geçici (TRANSIENT) hata dönerse NACK döner', async () => {
    consumer1.handle.mockResolvedValue({
      success: false,
      classification: FailureClassification.TRANSIENT,
      reason: 'DB Timeout',
    });
    runner = createRunner([consumer1]);

    const result = await runner.processEvent(validEnvelope);

    expect(result.action).toBe('NACK');
    // Telafi edici bir DELETE yok: işaret transaction ile birlikte geri alınır.
    // Yalnızca consumer'ın kendi transaction'ı açılmış olmalı (DLQ turu yok).
    expect(uow.withTransaction).toHaveBeenCalledTimes(1);
    expect(dlq.record).not.toHaveBeenCalled();
  });

  it('consumer hata fırlatırsa yakalanır ve TRANSIENT olarak sınıflandırılır', async () => {
    consumer1.handle.mockRejectedValue(new Error('Unexpected crash'));
    runner = createRunner([consumer1]);

    const result = await runner.processEvent(validEnvelope);

    expect(result.action).toBe('NACK');
    expect(metrics.consumerFailure).toHaveBeenCalled();
  });

  it('consumer TypeError fırlatırsa PERMANENT olarak sınıflandırılır', async () => {
    consumer1.handle.mockRejectedValue(new TypeError('Cannot read property'));
    runner = createRunner([consumer1]);

    const result = await runner.processEvent(validEnvelope);

    // PERMANENT → DLQ → ACK
    expect(result.action).toBe('ACK');
    expect(dlq.record).toHaveBeenCalledWith(
      expect.objectContaining({ classification: FailureClassification.PERMANENT }),
      client,
    );
  });

  it('aynı event type için birden fazla consumer varsa hepsi çalışır', async () => {
    runner = createRunner([consumer1, consumer2]);

    const result = await runner.processEvent(validEnvelope);

    expect(result.action).toBe('ACK');
    expect(consumer1.handle).toHaveBeenCalled();
    expect(consumer2.handle).toHaveBeenCalled();
  });

  it('bir consumer geçici hata alırsa diğeri başarılı olsa bile NACK döner', async () => {
    consumer2.handle.mockResolvedValue({
      success: false,
      classification: FailureClassification.TRANSIENT,
      reason: 'Timeout',
    });
    runner = createRunner([consumer1, consumer2]);

    const result = await runner.processEvent(validEnvelope);

    expect(result.action).toBe('NACK');
    expect(consumer1.handle).toHaveBeenCalled();
    expect(consumer2.handle).toHaveBeenCalled();
  });

  it("kalıcı hatada DLQ kaydı ve işlenmiş işareti aynı transaction'da yazılır", async () => {
    consumer1.handle.mockResolvedValue({
      success: false,
      classification: FailureClassification.PERMANENT,
      reason: 'Validation failed',
    });
    runner = createRunner([consumer1]);

    await runner.processEvent(validEnvelope);

    // İlk transaction consumer'ın (geri alındı), ikincisi DLQ + işaret.
    expect(uow.withTransaction).toHaveBeenCalledTimes(2);
    expect(dlq.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt-123' }),
      client,
    );
    expect(dedup.markProcessed).toHaveBeenLastCalledWith('test-consumer-1', 'evt-123', client);
  });

  it('COMMIT düşerse event başarılı sayılmaz (geçici hata → NACK)', async () => {
    commitFails = true;
    runner = createRunner([consumer1]);

    const result = await runner.processEvent(validEnvelope);

    expect(result.action).toBe('NACK');
    expect(metrics.consumerSuccess).not.toHaveBeenCalled();
    expect(metrics.consumerFailure).toHaveBeenCalled();
  });

  it('mükerrer event tespitinde consumer transaction içinde hiç çağrılmaz', async () => {
    dedup.markProcessed.mockResolvedValue(false);
    runner = createRunner([consumer1]);

    await runner.processEvent(validEnvelope);

    expect(consumer1.handle).not.toHaveBeenCalled();
    expect(uow.withTransaction).toHaveBeenCalledTimes(1);
  });

  it('runner durdurulursa NACK döner', async () => {
    runner = createRunner([consumer1]);
    await runner.onApplicationShutdown();

    const result = await runner.processEvent(validEnvelope);

    expect(result.action).toBe('NACK');
    expect(result.reason).toContain('Runner kapatılıyor');
    expect(consumer1.handle).not.toHaveBeenCalled();
  });
});
