import type { INestApplication } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import request from 'supertest';
import { EVENT_TRANSPORT } from '../src/common/outbox/event-transport';
import { OutboxPublisher } from '../src/common/outbox/outbox.publisher';
import {
  PREFIX,
  bearer,
  clearRateLimits,
  createPool,
  createRedis,
  createTestApp,
  ensureCatalog,
  resetDomainTables,
} from './helpers/test-app';

/**
 * Faz 14 — bağımlılık arızalarında bozulma davranışı (S-05).
 *
 * Redis **erişilemez** hâle getirilerek ölçülür. Bileşen mock'lanmaz; adres
 * erişilemez bir porta çevrilir (mevcut testlerin "bileşeni değil dünyayı değiştir"
 * yaklaşımı). Böylece ölçülen şey gerçek istemcinin gerçek hata yoludur.
 *
 * Beklenen davranış tasarlanmıştır, keşfedilmemiştir:
 * - Oran sınırlı uçlar **fail-closed**'dır (ADR-0003): Redis yoksa sayaç tutulamaz,
 *   korumasız trafik kabul edilmez. Yani Redis kesintisi bu uçları **kapatır**.
 * - Panik ucunda oran sınırı **yoktur** (ADR-0008 §3): Redis kesintisi paniği
 *   bloklamamalıdır.
 * - Doğruluk kaynağı veritabanıdır; Redis kaybı çifte rezervasyon veya bozuk state
 *   üretmemelidir.
 */
describe('bozulma davranışı — Redis erişilemez (integration)', () => {
  /** Hiçbir şeyin dinlemediği port: gerçek bağlantı hatası üretir. */
  const UNREACHABLE_REDIS = 'redis://127.0.0.1:6399';

  let pool: Pool;
  let liveRedis: Redis;

  beforeAll(() => {
    pool = createPool();
    liveRedis = createRedis();
  });

  beforeEach(async () => {
    await resetDomainTables(pool);
    await clearRateLimits(liveRedis);
    await ensureCatalog(pool);
  });

  afterAll(async () => {
    await pool?.end();
    liveRedis?.disconnect();
  });

  it('oran sınırlı uç fail-closed davranır ve 5xx sızdırmaz', async () => {
    const app = await createTestApp({ env: { REDIS_URL: UNREACHABLE_REDIS } });
    try {
      const response = await request(app.getHttpServer())
        .post(`${PREFIX}/auth/session`)
        .set('authorization', bearer('degraded-user'));

      // Fail-closed: istek reddedilir. Reddin **429** olması önemlidir — 500 olsaydı
      // bu tasarlanmış bir koruma değil, sızan bir altyapı hatası olurdu.
      expect(response.status).toBe(429);
      expect(response.body.error.code).toBe('RATE_LIMITED');
      expect(JSON.stringify(response.body)).not.toMatch(/redis|ECONNREFUSED|6399/i);
    } finally {
      await app.close();
    }
  }, 60000);

  it('Redis erişilemezken sağlık ucu 503 ve redis "down" raporlar', async () => {
    const app = await createTestApp({ env: { REDIS_URL: UNREACHABLE_REDIS } });
    try {
      const response = await request(app.getHttpServer()).get(`${PREFIX}/health`);

      expect(response.status).toBe(503);
      expect(response.body.checks.redis.status).toBe('down');
      // Postgres sağlamdır: tek bağımlılığın düşmesi diğerini "down" göstermemeli.
      expect(response.body.checks.postgres.status).toBe('up');
    } finally {
      await app.close();
    }
  }, 60000);

  it('liveness ucu bağımlılık kontrolü yapmaz: Redis düşünce container yeniden başlatılmaz', async () => {
    const app = await createTestApp({ env: { REDIS_URL: UNREACHABLE_REDIS } });
    try {
      await request(app.getHttpServer()).get(`${PREFIX}/health/live`).expect(200);
    } finally {
      await app.close();
    }
  }, 60000);
});

/**
 * Faz 14 — Pub/Sub erişilemezken transactional domain state kaybolmamalı (S-11).
 *
 * `EventTransport` **dış servis sınırıdır**; test yardımcısının açıkça izin verdiği
 * değiştirme noktası budur. Domain servisi değiştirilmez — değiştirilseydi test kendi
 * kurgusunu ölçerdi.
 *
 * Doğrulanan sözleşme: outbox, yayınlanamayan event'i **kaybetmez**; satır kalır,
 * deneme sayısı artar, `next_attempt_at` ileri atılır ve rezervasyonun kendisi
 * commit edilmiş kalır. Teslim **at-least-once**'tır; burada exactly-once iddia
 * edilmez.
 */
describe('bozulma davranışı — Pub/Sub erişilemez (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;

  /** Her yayını reddeden taşıma: gerçek bir kesintinin outbox’a görünen yüzü. */
  const failingTransport = {
    publish: jest.fn().mockRejectedValue(new Error('pubsub unavailable')),
  };

  beforeAll(async () => {
    pool = createPool();
    redis = createRedis();
    app = await createTestApp({
      overrides: [{ token: EVENT_TRANSPORT, value: failingTransport }],
    });
  });

  beforeEach(async () => {
    await resetDomainTables(pool);
    await clearRateLimits(redis);
    await ensureCatalog(pool);
    // `mockClear` yalnızca çağrı kaydını siler, **uygulamayı** değil. İkinci test
    // taşımayı kalıcı olarak başarılı hâle getiriyordu; üçüncü bir test eklendiğinde
    // (ya da testler farklı sırada koştuğunda) "Pub/Sub erişilemez" başlıklı bir test
    // sağlıklı bir taşımayı sınar ve **yanlış nedenle** geçerdi.
    failingTransport.publish.mockReset().mockRejectedValue(new Error('pubsub unavailable'));
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    redis?.disconnect();
  });

  it('yayın başarısızken domain state commit kalır ve event outbox’ta bekler', async () => {
    const token = bearer('pubsub-down-user');
    await request(app.getHttpServer())
      .post(`${PREFIX}/auth/session`)
      .set('authorization', token)
      .expect(201);

    // Kullanıcı kaydı domain işidir ve event üretir: yayın düşse de kayıt durmalı.
    const users = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM users`);
    expect(Number(users.rows[0]?.count)).toBeGreaterThan(0);

    const publisher = app.get(OutboxPublisher);
    await publisher.drain();

    expect(failingTransport.publish).toHaveBeenCalled();

    // Event kaybolmadı: satır duruyor, PUBLISHED değil, denemesi artmış.
    const outbox = await pool.query<{
      status: string;
      attempts: number;
      future: boolean;
    }>(
      `SELECT status::text AS status, attempts, next_attempt_at > now() AS future
         FROM outbox ORDER BY occurred_at LIMIT 1`,
    );
    const row = outbox.rows[0];
    expect(row).toBeDefined();
    expect(row!.status).not.toBe('PUBLISHED');
    expect(row!.attempts).toBeGreaterThan(0);
    // Backoff: hemen tekrar denenmez, ama kalıcı olarak da bırakılmaz.
    expect(row!.future).toBe(true);
  });

  it('taşıma geri geldiğinde bekleyen event yayınlanır (at-least-once)', async () => {
    await request(app.getHttpServer())
      .post(`${PREFIX}/auth/session`)
      .set('authorization', bearer('pubsub-recovers-user'))
      .expect(201);

    const publisher = app.get(OutboxPublisher);
    await publisher.drain();

    const pending = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM outbox WHERE status <> 'PUBLISHED'`,
    );
    expect(Number(pending.rows[0]?.count)).toBeGreaterThan(0);

    // Taşıma düzelir ve backoff penceresi elle geçilir (zaman beklenmez).
    failingTransport.publish.mockResolvedValue(undefined);
    await pool.query(`UPDATE outbox SET next_attempt_at = now() - interval '1 minute'`);

    await publisher.drain();

    const remaining = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM outbox WHERE status <> 'PUBLISHED'`,
    );
    expect(Number(remaining.rows[0]?.count)).toBe(0);
  });
});
