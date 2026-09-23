import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { EVENT_TRANSPORT, type OutboundEvent } from '../src/common/outbox/event-transport';
import { OutboxPublisher, OUTBOX_MAX_ATTEMPTS } from '../src/common/outbox/outbox.publisher';
import { EventMetrics } from '../src/common/events/event-metrics';
import { EventConsumerRunner } from '../src/common/events/event-consumer-runner';
import { EVENT_CONSUMERS, FailureClassification } from '../src/common/events/event-consumer';
import type { ConsumedEvent, EventConsumer } from '../src/common/events/event-consumer';
import { ROOT_LOGGER } from '../src/common/logging/logging.tokens';
import { createPool, createTestApp, resetDomainTables } from './helpers/test-app';

/**
 * Faz 14 — arıza ve kurtarma (S-12).
 *
 * Faz 13'e kadar ölçülen şey "mutlu yol + tek seferlik hata"ydı. Burada sorulan
 * farklı: **süreç ortadan kaybolursa** sistem ne yapıyor? Üç kurtarma mekanizması
 * ayrı ayrı sınanır:
 *
 *   1. Outbox kiralaması (`CLAIM_LEASE_SECONDS`) — ölen instance'ın sahiplendiği
 *      event'ler kaybolmaz ama kira dolmadan da ikinci kez yayınlanmaz.
 *   2. Consumer deduplication geri alma — TRANSIENT hatada iş etkisi yok, kayıt
 *      geri alınır, yeniden teslim başarılı olur; PERMANENT hatada kayıt **kalır**
 *      ve yeniden teslim ikinci bir yan etki üretmez.
 *   3. Deneme hakkının bitmesi — `FAILED` kayıt sessizce yeniden denenmez.
 *
 * Zaman **beklenmez**: kira/backoff pencereleri SQL ile geriye alınır. Bekleyen bir
 * test, ölçtüğü şeyi değil makinenin hızını ölçer.
 */
describe('arıza ve kurtarma — outbox kiralaması ve consumer yeniden teslimi (integration)', () => {
  let app: INestApplication;
  let pool: Pool;

  /** Yayını istenildiğinde reddeden/askıya alan taşıma (dış servis sınırı). */
  const transport = {
    mode: 'ok' as 'ok' | 'fail' | 'hang',
    published: [] as string[],
    release: undefined as undefined | (() => void),
    async publish(event: OutboundEvent): Promise<void> {
      if (transport.mode === 'fail') {
        throw new Error('transport unavailable');
      }
      if (transport.mode === 'hang') {
        // Sonsuza dek beklemez; testin serbest bırakacağı bir kilit.
        await new Promise<void>((resolve) => {
          transport.release = resolve;
        });
      }
      transport.published.push(event.eventId);
    },
  };

  beforeAll(async () => {
    pool = createPool();
    app = await createTestApp({ overrides: [{ token: EVENT_TRANSPORT, value: transport }] });
  });

  beforeEach(async () => {
    await resetDomainTables(pool);
    transport.mode = 'ok';
    transport.published = [];
    transport.release = undefined;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  /** Outbox'a doğrudan event yazar (domain yolu ayrı testlerde doğrulanıyor). */
  async function enqueue(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const result = await pool.query<{ event_id: string }>(
        `INSERT INTO outbox (event_type, event_version, subject_type, subject_id, payload)
         VALUES ('BookingCreated', 1, 'booking', $1, $2)
         RETURNING event_id`,
        [randomUUID(), JSON.stringify({ bookingId: randomUUID() })],
      );
      ids.push(result.rows[0]!.event_id);
    }
    return ids;
  }

  /** İkinci bir uygulama instance'ının yayıncısı (aynı veritabanı, ayrı süreç gibi). */
  function secondInstancePublisher(): OutboxPublisher {
    return new OutboxPublisher(
      pool,
      transport,
      app.get<Logger>(ROOT_LOGGER),
      app.get(EventMetrics),
    );
  }

  async function outboxRow(eventId: string) {
    const result = await pool.query<{
      status: string;
      attempts: number;
      claimed: boolean;
    }>(
      `SELECT status::text AS status, attempts, next_attempt_at > now() AS claimed
         FROM outbox WHERE event_id = $1`,
      [eventId],
    );
    return result.rows[0];
  }

  it('sahiplenilen event kira süresince ikinci instance tarafından alınamaz', async () => {
    const [eventId] = await enqueue(1);
    transport.mode = 'hang';

    const first = secondInstancePublisher();
    const inFlight = first.drain();

    // Yayın askıdayken kayıt sahiplenilmiştir: `next_attempt_at` ileri atılmıştır.
    await expectEventually(async () => (await outboxRow(eventId!))?.claimed === true);

    // İkinci instance aynı anda tur atar: kirada olan kaydı **görmez**.
    const second = secondInstancePublisher();
    expect(await second.drain()).toBe(0);

    transport.release?.();
    await inFlight;

    // Tam olarak bir kez yayınlandı.
    expect(transport.published.filter((id) => id === eventId)).toHaveLength(1);
    expect((await outboxRow(eventId!))?.status).toBe('PUBLISHED');
  }, 30000);

  it('instance çökerse kira dolunca event yeniden sahiplenilir ve kaybolmaz', async () => {
    const [eventId] = await enqueue(1);

    // "Çökme": kayıt sahiplenildi, yayın hiç tamamlanmadı, süreç gitti.
    transport.mode = 'hang';
    const dying = secondInstancePublisher();
    const abandoned = dying.drain();
    await expectEventually(async () => (await outboxRow(eventId!))?.claimed === true);

    // Kira dolar. (Gerçekte 30 sn; testte saat ileri alınmaz, kayıt geriye alınır.)
    await pool.query(`UPDATE outbox SET next_attempt_at = now() - interval '1 second'`);

    transport.mode = 'ok';
    const recovered = secondInstancePublisher();
    expect(await recovered.drain()).toBe(1);
    expect((await outboxRow(eventId!))?.status).toBe('PUBLISHED');

    // Ölen turu serbest bırak. Bu, **bilerek** aynı event'in ikinci kez
    // yayınlanmasına yol açar — ilk testteki "tam olarak bir kez" garantisi kira
    // penceresi içindir, koşulsuz değildir. Teslim at-least-once'tır; ikinci
    // teslimi zararsız kılan şey tüketici tarafındaki dedup'tır (aşağıdaki suite).
    transport.mode = 'ok';
    transport.release?.();
    await abandoned;
  }, 30000);

  it('deneme hakkı bitince kayıt FAILED olur ve bir daha sahiplenilmez', async () => {
    const [eventId] = await enqueue(1);
    transport.mode = 'fail';

    const publisher = secondInstancePublisher();
    for (let attempt = 0; attempt < OUTBOX_MAX_ATTEMPTS; attempt += 1) {
      await publisher.drain();
      // Backoff penceresi elle geçilir: ölçülen şey backoff süresi değil, sayaçtır.
      await pool.query(`UPDATE outbox SET next_attempt_at = now() - interval '1 second'`);
    }

    const row = await outboxRow(eventId!);
    expect(row?.status).toBe('FAILED');
    expect(row?.attempts).toBe(OUTBOX_MAX_ATTEMPTS);

    // Taşıma düzelse bile FAILED kayıt **kendiliğinden** yeniden denenmez: claim
    // sorgusu yalnızca PENDING okur. Kurtarma operasyonel bir karardır.
    transport.mode = 'ok';
    expect(await publisher.drain()).toBe(0);
    expect(transport.published).toHaveLength(0);
  }, 60000);
});

/**
 * Consumer tarafı yeniden teslim davranışı.
 *
 * Sahte consumer **DI sınırında** kaydedilir (`EVENT_CONSUMERS`): runner'ın gerçek
 * pipeline'ı (dedup → handle → sınıflandırma → DLQ) değiştirilmeden ölçülür.
 */
describe('arıza ve kurtarma — consumer yeniden teslimi (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let runner: EventConsumerRunner;

  const CONSUMER_NAME = 'failure-recovery-probe';

  /** Yan etkisi sayılabilir, davranışı testten yönlendirilebilir consumer. */
  const probe = {
    consumerName: CONSUMER_NAME,
    eventTypes: ['BookingCreated'],
    behaviour: 'ok' as 'ok' | 'transient' | 'permanent',
    effects: [] as string[],
    async handle(event: ConsumedEvent) {
      if (probe.behaviour === 'transient') {
        return {
          success: false as const,
          classification: FailureClassification.TRANSIENT,
          reason: 'geçici arıza (test)',
        };
      }
      if (probe.behaviour === 'permanent') {
        return {
          success: false as const,
          classification: FailureClassification.PERMANENT,
          reason: 'kalıcı arıza (test)',
        };
      }
      probe.effects.push(event.eventId);
      return { success: true as const };
    },
  } satisfies EventConsumer & { behaviour: string; effects: string[] };

  beforeAll(async () => {
    pool = createPool();
    app = await createTestApp({
      overrides: [{ token: EVENT_CONSUMERS, value: [probe] }],
    });
    runner = app.get(EventConsumerRunner);
  });

  beforeEach(async () => {
    await resetDomainTables(pool);
    probe.behaviour = 'ok';
    probe.effects = [];
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  const event = (): Record<string, unknown> => ({
    eventId: randomUUID(),
    eventType: 'BookingCreated',
    eventVersion: 1,
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    aggregateType: 'booking',
    aggregateId: randomUUID(),
    producer: 'test',
    correlationId: null,
    payload: { bookingId: randomUUID() },
  });

  async function processedCount(eventId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM processed_events WHERE consumer = $1 AND event_id = $2`,
      [CONSUMER_NAME, eventId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  it('geçici hata NACK üretir, işaret geri alınır ve yeniden teslim başarılı olur', async () => {
    const message = event();
    const eventId = message['eventId'] as string;

    probe.behaviour = 'transient';
    const failed = await runner.processEvent(message);
    expect(failed.action).toBe('NACK');
    // Kritik: işaret geri alınmalı. Kalsaydı yeniden teslim "duplicate" sayılır ve
    // event hiç işlenmeden sessizce kaybolurdu.
    expect(await processedCount(eventId)).toBe(0);
    expect(probe.effects).toHaveLength(0);

    probe.behaviour = 'ok';
    const retried = await runner.processEvent(message);
    expect(retried.action).toBe('ACK');
    expect(probe.effects).toEqual([eventId]);
    expect(await processedCount(eventId)).toBe(1);
  }, 30000);

  it('geçici hata tekrarlansa da yan etki hiç oluşmaz (tekrar tekrar güvenli)', async () => {
    const message = event();
    probe.behaviour = 'transient';

    for (let i = 0; i < 3; i += 1) {
      expect((await runner.processEvent(message)).action).toBe('NACK');
    }

    expect(probe.effects).toHaveLength(0);
    expect(await processedCount(message['eventId'] as string)).toBe(0);
  }, 30000);

  it('kalıcı hata DLQ üretir; yeniden teslim ikinci DLQ kaydı veya yan etki üretmez', async () => {
    const message = event();
    const eventId = message['eventId'] as string;

    probe.behaviour = 'permanent';
    const first = await runner.processEvent(message);
    // ACK: yeniden denemek anlamsızdır, mesaj sonsuza dek dönmemelidir.
    expect(first.action).toBe('ACK');

    const dlq = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM dead_letter_events WHERE event_id = $1`,
      [eventId],
    );
    expect(Number(dlq.rows[0]?.count)).toBe(1);
    // İşaret **kalır**: DLQ'ya düşen event kendiliğinden yeniden işlenmez.
    expect(await processedCount(eventId)).toBe(1);

    // Pub/Sub at-least-once teslim eder: aynı mesaj yeniden gelirse ne olur?
    probe.behaviour = 'ok';
    const redelivered = await runner.processEvent(message);
    expect(redelivered.action).toBe('ACK');

    // Ne ikinci bir DLQ kaydı, ne de bir yan etki. Kurtarma manuel replay'dir
    // (işaret elle silinir) — sessiz bir "kendi kendine düzelme" yoktur.
    const dlqAfter = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM dead_letter_events WHERE event_id = $1`,
      [eventId],
    );
    expect(Number(dlqAfter.rows[0]?.count)).toBe(1);
    expect(probe.effects).toHaveLength(0);
  }, 30000);
});

/** Kısa aralıklarla koşulu yoklar; sabit `sleep` yerine (makine hızına bağlanmamak için). */
async function expectEventually(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Koşul zaman aşımına uğradı');
}
