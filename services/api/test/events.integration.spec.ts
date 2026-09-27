import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { createTestApp, createPool, resetDomainTables } from './helpers/test-app';
import { EventConsumerRunner } from '../src/common/events/event-consumer-runner';
import { EventDeduplicationService } from '../src/common/events/event-deduplication.service';
import { DeadLetterService } from '../src/common/events/dead-letter.service';
import { UnitOfWork } from '../src/common/database/unit-of-work';
import { FailureClassification } from '../src/common/events/event-consumer';

describe('events infrastructure (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let runner: EventConsumerRunner;
  let dedup: EventDeduplicationService;
  let dlq: DeadLetterService;
  let uow: UnitOfWork;

  beforeAll(async () => {
    app = await createTestApp();
    pool = createPool();
    runner = app.get(EventConsumerRunner);
    dedup = app.get(EventDeduplicationService);
    dlq = app.get(DeadLetterService);
    uow = app.get(UnitOfWork);
  });

  beforeEach(async () => {
    await resetDomainTables(pool);
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  // event_id/aggregate_id ve (bildirim alıcısı olarak kullanılan) bookingId/customerId gibi
  // referans alanları DB'de UUID sütunlarına yazılır (processed_events, dead_letter_events,
  // notification_jobs, analytics_events) — bu yüzden testler gerçek UUID kullanmalıdır.
  const createEvent = (eventType: string, payload: Record<string, unknown>) => ({
    eventId: randomUUID(),
    eventType,
    eventVersion: 1,
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    aggregateType: 'booking',
    aggregateId: randomUUID(),
    producer: 'test',
    correlationId: null,
    payload,
  });

  // --- Consumer Runner ---

  it('geçerli BookingCreated olayı → notification_jobs ve analytics_events yazılır', async () => {
    const customerId = randomUUID();
    const event = createEvent('BookingCreated', {
      bookingId: randomUUID(),
      serviceId: randomUUID(),
      customerId,
    });

    const result = await runner.processEvent(event);
    expect(result.action).toBe('ACK');

    // Notification job
    const jobs = await pool.query(`SELECT * FROM notification_jobs WHERE event_id = $1`, [
      event.eventId,
    ]);
    expect(jobs.rowCount).toBe(1);
    expect(jobs.rows[0].template_key).toBe('booking.created');
    expect(jobs.rows[0].recipient_user_id).toBe(customerId);

    // Analytics event
    const analytics = await pool.query(`SELECT * FROM analytics_events WHERE event_id = $1`, [
      event.eventId,
    ]);
    expect(analytics.rowCount).toBe(1);
    expect(analytics.rows[0].event_type).toBe('BookingCreated');

    // Processed events (her iki consumer için)
    const processed = await pool.query(`SELECT * FROM processed_events WHERE event_id = $1`, [
      event.eventId,
    ]);
    expect(processed.rowCount).toBe(2);
  });

  it('SafetyAlertRaised → analytics_events ve notification_jobs yazılır', async () => {
    const event = createEvent('SafetyAlertRaised', {
      safetySessionId: randomUUID(),
      bookingId: randomUUID(),
      severity: 'HIGH',
      source: 'PANIC',
    });

    await runner.processEvent(event);

    const analytics = await pool.query(`SELECT * FROM analytics_events WHERE event_id = $1`, [
      event.eventId,
    ]);
    expect(analytics.rowCount).toBe(1);
    expect(analytics.rows[0].payload).toMatchObject({ severity: 'HIGH', source: 'PANIC' });
  });

  // --- Deduplication ---

  it('aynı event ikinci kez gönderildiğinde yeniden işlenmez', async () => {
    const event = createEvent('BookingCreated', {
      bookingId: randomUUID(),
      customerId: randomUUID(),
      serviceId: randomUUID(),
    });

    const res1 = await runner.processEvent(event);
    const res2 = await runner.processEvent(event);

    expect(res1.action).toBe('ACK');
    expect(res2.action).toBe('ACK');

    // Yalnızca bir kez yazıldı
    const analytics = await pool.query(
      `SELECT count(*)::int AS cnt FROM analytics_events WHERE event_id = $1`,
      [event.eventId],
    );
    expect(analytics.rows[0].cnt).toBe(1);
  });

  it('concurrent duplicate delivery — ON CONFLICT sayesinde yalnızca biri işlenir', async () => {
    const event = createEvent('BookingCreated', {
      bookingId: randomUUID(),
      customerId: randomUUID(),
      serviceId: randomUUID(),
    });

    const [r1, r2] = await Promise.all([runner.processEvent(event), runner.processEvent(event)]);

    expect(r1.action).toBe('ACK');
    expect(r2.action).toBe('ACK');

    const analytics = await pool.query(
      `SELECT count(*)::int AS cnt FROM analytics_events WHERE event_id = $1`,
      [event.eventId],
    );
    expect(analytics.rows[0].cnt).toBe(1);
  });

  // --- Event Deduplication Service ---

  it("markProcessed aynı transaction'da ilk çağrıda true, ikinci çağrıda false döner", async () => {
    const eventId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const first = await dedup.markProcessed('test-consumer', eventId, client);
      const second = await dedup.markProcessed('test-consumer', eventId, client);
      await client.query('COMMIT');

      expect(first).toBe(true);
      expect(second).toBe(false);
    } finally {
      client.release();
    }
  });

  /**
   * R-75: işaret iş etkisiyle **aynı** transaction'da olduğu için geri alma
   * telafi edici bir DELETE değil, ROLLBACK'in kendisidir. Süreç işaretleme ile
   * iş etkisi arasında çökemez: ikisi tek commit'tir.
   */
  it('rollback edilen transaction işaret bırakmaz', async () => {
    const eventId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      expect(await dedup.markProcessed('test-consumer', eventId, client)).toBe(true);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    expect(await dedup.isProcessed('test-consumer', eventId)).toBe(false);
  });

  it('isProcessed commit edilmiş işareti görür', async () => {
    const eventId = randomUUID();
    expect(await dedup.isProcessed('test-consumer', eventId)).toBe(false);

    await uow.withTransaction((client) => dedup.markProcessed('test-consumer', eventId, client));

    expect(await dedup.isProcessed('test-consumer', eventId)).toBe(true);
  });

  it("runner işareti ve iş etkisini aynı transaction'da commit eder", async () => {
    const event = createEvent('BookingCreated', {
      bookingId: randomUUID(),
      serviceId: randomUUID(),
      customerId: randomUUID(),
    });

    expect((await runner.processEvent(event)).action).toBe('ACK');

    // İşaret ve iş etkisi birlikte var: biri olup diğeri olmayan bir ara durum yok.
    const rows = await pool.query<{ processed: number; analytics: number }>(
      `SELECT
         (SELECT count(*)::int FROM processed_events
           WHERE event_id = $1 AND consumer = 'analytics-export') AS processed,
         (SELECT count(*)::int FROM analytics_events WHERE event_id = $1) AS analytics`,
      [event.eventId],
    );
    expect(rows.rows[0]).toEqual({ processed: 1, analytics: 1 });
  });

  // --- Dead Letter Service ---

  it('DLQ kaydı oluşturulur ve unresolvedCount artar', async () => {
    const countBefore = await dlq.unresolvedCount();
    const eventId = randomUUID();

    await dlq.record({
      eventId,
      eventType: 'TestEvent',
      eventVersion: 1,
      consumer: 'test-consumer',
      payload: { key: 'value' },
      attemptCount: 3,
      classification: FailureClassification.PERMANENT,
      reason: 'Schema validation failed',
    });

    const countAfter = await dlq.unresolvedCount();
    expect(countAfter).toBe(countBefore + 1);

    const dlqRows = await pool.query(
      `SELECT * FROM dead_letter_events WHERE event_id = $1 AND consumer = $2`,
      [eventId, 'test-consumer'],
    );
    expect(dlqRows.rowCount).toBe(1);
    expect(dlqRows.rows[0].failure_classification).toBe('PERMANENT');
    expect(dlqRows.rows[0].attempt_count).toBe(3);
  });

  it('DLQ unresolvedByConsumer consumer bazında sayıları döner', async () => {
    await dlq.record({
      eventId: randomUUID(),
      eventType: 'TestEvent',
      eventVersion: 1,
      consumer: 'consumer-a',
      payload: {},
      attemptCount: 1,
      classification: FailureClassification.PERMANENT,
      reason: 'Error A',
    });
    await dlq.record({
      eventId: randomUUID(),
      eventType: 'TestEvent',
      eventVersion: 1,
      consumer: 'consumer-a',
      payload: {},
      attemptCount: 2,
      classification: FailureClassification.TRANSIENT,
      reason: 'Error B',
    });
    await dlq.record({
      eventId: randomUUID(),
      eventType: 'TestEvent',
      eventVersion: 1,
      consumer: 'consumer-b',
      payload: {},
      attemptCount: 1,
      classification: FailureClassification.PERMANENT,
      reason: 'Error C',
    });

    const result = await dlq.unresolvedByConsumer();
    const consumerA = result.find((r) => r.consumer === 'consumer-a');
    const consumerB = result.find((r) => r.consumer === 'consumer-b');

    expect(consumerA?.count).toBe(2);
    expect(consumerB?.count).toBe(1);
  });

  // --- NotificationJobConsumer ---

  it('PaymentReleased → bildirim işi oluşturulur', async () => {
    const event = createEvent('PaymentReleased', {
      paymentId: randomUUID(),
      bookingId: randomUUID(),
      amountMinor: '15000',
    });

    await runner.processEvent(event);

    const jobs = await pool.query(`SELECT * FROM notification_jobs WHERE event_id = $1`, [
      event.eventId,
    ]);
    expect(jobs.rowCount).toBe(1);
    expect(jobs.rows[0].template_key).toBe('payment.released');
  });

  // --- Bilinmeyen event tipi ---

  it('bilinmeyen event tipi ACK ile atılır', async () => {
    const event = createEvent('SomeUnknownEvent', { data: 1 });

    const result = await runner.processEvent(event);

    expect(result.action).toBe('ACK');
    expect(result.reason).toContain('Dinleyen consumer yok');
  });
});
