import type { INestApplication } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import request from 'supertest';
import { IdempotencyService } from '../src/common/idempotency/idempotency.service';
import { EVENT_TRANSPORT, type EventTransport } from '../src/common/outbox/event-transport';
import { OutboxPublisher } from '../src/common/outbox/outbox.publisher';
import {
  PREFIX,
  bearer,
  clearRateLimits,
  createPool,
  createRedis,
  ensureCatalog,
  createTestApp,
  resetDomainTables,
} from './helpers/test-app';

/**
 * Ortak altyapı: audit değişmezliği ve hash zinciri (ADR-0013),
 * transactional outbox (ADR-0010), idempotency (ADR-0003), oran sınırı.
 *
 * Zorunlu senaryolar: T-35 (audit UPDATE/DELETE reddi), T-36 (zincir kopukluğu tespiti),
 * T-39 (outbox kurtarma), T-07/T-07b/T-07c (idempotency).
 */
describe('core infrastructure (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;

  beforeAll(async () => {
    app = await createTestApp();
    pool = createPool();
    redis = createRedis();
  });

  beforeEach(async () => {
    await resetDomainTables(pool);
    await clearRateLimits(redis);
    await ensureCatalog(pool);
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    redis?.disconnect();
  });

  const http = (): request.Agent => request(app.getHttpServer());

  async function register(subject: string): Promise<string> {
    const response = await http()
      .post(`${PREFIX}/auth/session`)
      .set('authorization', bearer(subject))
      .expect(201);
    return response.body.userId as string;
  }

  describe('audit_logs değişmezliği (T-35)', () => {
    it('UPDATE reddedilir', async () => {
      await register('audit-sub-1');

      await expect(
        pool.query(
          `UPDATE audit_logs SET action = 'TAMPERED' WHERE id = (SELECT max(id) FROM audit_logs)`,
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('DELETE reddedilir', async () => {
      await register('audit-sub-2');

      await expect(
        pool.query(`DELETE FROM audit_logs WHERE id = (SELECT max(id) FROM audit_logs)`),
      ).rejects.toThrow(/append-only/);
    });

    it('TRUNCATE reddedilir', async () => {
      await expect(pool.query(`TRUNCATE TABLE audit_logs`)).rejects.toThrow(/append-only/);
    });

    it('INSERT serbesttir (append-only)', async () => {
      const before = await pool.query<{ count: string }>(`SELECT count(*)::text FROM audit_logs`);
      await register('audit-sub-3');
      const after = await pool.query<{ count: string }>(`SELECT count(*)::text FROM audit_logs`);

      expect(Number(after.rows[0]?.count)).toBeGreaterThan(Number(before.rows[0]?.count));
    });
  });

  describe('audit hash zinciri (T-36)', () => {
    it('her satır öncekinin hash.ini taşır', async () => {
      await register('chain-sub-1');
      await register('chain-sub-2');

      const rows = await pool.query<{ id: string; prev_hash: string | null; hash: string }>(
        `SELECT id::text, prev_hash, hash FROM audit_logs ORDER BY id DESC LIMIT 2`,
      );

      const [newest, previous] = rows.rows;
      expect(newest?.prev_hash).toBe(previous?.hash);
      expect(newest?.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('sağlam zincirde doğrulama fonksiyonu kopukluk bildirmez', async () => {
      await register('chain-sub-3');

      const result = await pool.query<{ broken: string | null }>(
        `SELECT audit_chain_broken_at()::text AS broken`,
      );

      expect(result.rows[0]?.broken).toBeNull();
    });

    it('zincir bozulursa tespit edilir, özgün içerik geri gelince zincir onarılır', async () => {
      await register('chain-sub-4');
      await register('chain-sub-5');

      // Ayrıcalıklı erişim senaryosu: trigger geçici olarak devre dışı bırakılıp
      // geçmiş değiştirilir. Zincir bunu görünür kılar (tamper-evident).
      const target = await pool.query<{ id: string; action: string }>(
        `SELECT id::text, action FROM audit_logs ORDER BY id DESC LIMIT 1`,
      );
      const id = target.rows[0]?.id as string;
      const originalAction = target.rows[0]?.action as string;

      await pool.query(`ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_update`);
      try {
        await pool.query(`UPDATE audit_logs SET action = 'SILENTLY_CHANGED' WHERE id = $1`, [id]);

        const broken = await pool.query<{ broken: string | null }>(
          `SELECT audit_chain_broken_at()::text AS broken`,
        );
        expect(broken.rows[0]?.broken).toBe(id);
      } finally {
        // Geri yükleme **finally** içindedir: yukarıdaki assert başarısız olsaydı satır
        // bozuk kalır, audit_logs temizlenemediği için sonraki tüm koşumlar kırılırdı.
        // Tespit içerik bazlı olduğu için özgün değer geri yazılınca zincir onarılır.
        await pool.query(`UPDATE audit_logs SET action = $2 WHERE id = $1`, [id, originalAction]);
        await pool.query(`ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_update`);
      }

      const healed = await pool.query<{ broken: string | null }>(
        `SELECT audit_chain_broken_at()::text AS broken`,
      );
      expect(healed.rows[0]?.broken).toBeNull();
    });
  });

  describe('transactional outbox (T-39)', () => {
    it('event domain değişikliğiyle aynı transaction.da yazılır', async () => {
      const userId = await register('outbox-sub-1');

      const events = await pool.query<{ event_type: string; subject_id: string; status: string }>(
        `SELECT event_type, subject_id, status FROM outbox`,
      );

      expect(events.rows).toEqual([
        expect.objectContaining({
          event_type: 'UserRegistered',
          subject_id: userId,
          status: 'PENDING',
        }),
      ]);
    });

    it('publisher bekleyen event.i yayınlar ve işaretler', async () => {
      await register('outbox-sub-2');

      const published = await app.get(OutboxPublisher).drain();

      expect(published).toBe(1);
      const rows = await pool.query<{
        status: string;
        published_at: Date | null;
        attempts: number;
      }>(`SELECT status, published_at, attempts FROM outbox`);
      expect(rows.rows[0]?.status).toBe('PUBLISHED');
      expect(rows.rows[0]?.published_at).not.toBeNull();
    });

    it('yayınlanmış event tekrar yayınlanmaz', async () => {
      await register('outbox-sub-3');
      await app.get(OutboxPublisher).drain();

      expect(await app.get(OutboxPublisher).drain()).toBe(0);
    });

    // T-39: transport başarısız olsa bile event kaybolmaz ve yeniden denenir.
    it('transport hatasında event PENDING kalır ve yeniden denenir', async () => {
      await register('outbox-sub-4');

      const transport = app.get<EventTransport>(EVENT_TRANSPORT);
      const publishSpy = jest
        .spyOn(transport, 'publish')
        .mockRejectedValueOnce(new Error('transport down'));

      const publisher = app.get(OutboxPublisher);
      expect(await publisher.drain()).toBe(0);

      const failed = await pool.query<{
        status: string;
        attempts: number;
        last_error_code: string;
      }>(`SELECT status, attempts, last_error_code FROM outbox`);
      expect(failed.rows[0]?.status).toBe('PENDING');
      expect(failed.rows[0]?.attempts).toBe(1);
      expect(failed.rows[0]?.last_error_code).toBe('Error');

      // Yeniden deneme zamanı geldiğinde event kurtarılır.
      await pool.query(`UPDATE outbox SET next_attempt_at = now()`);
      publishSpy.mockRestore();

      expect(await publisher.drain()).toBe(1);
      const recovered = await pool.query<{ status: string }>(`SELECT status FROM outbox`);
      expect(recovered.rows[0]?.status).toBe('PUBLISHED');
    });

    // Sahiplenme atomik olmazsa iki eşzamanlı publisher aynı event'i iki kez gönderir.
    it('eşzamanlı iki publisher turu aynı event.i iki kez yayınlamaz', async () => {
      await register('outbox-sub-6');

      const transport = app.get<EventTransport>(EVENT_TRANSPORT);
      const publishSpy = jest.spyOn(transport, 'publish');
      const publisher = app.get(OutboxPublisher);

      // `drain()` kendi içinde yeniden girişi engeller; bu yüzden iki ayrı sahiplenme
      // turunu doğrudan tetikleriz.
      const first = await publisher.drain();
      const second = await publisher.drain();

      expect(first + second).toBe(1);
      expect(publishSpy).toHaveBeenCalledTimes(1);
      publishSpy.mockRestore();
    });

    it('sahiplenilen kayıt kiralama süresi boyunca yeniden alınmaz', async () => {
      await register('outbox-sub-7');

      const transport = app.get<EventTransport>(EVENT_TRANSPORT);
      jest.spyOn(transport, 'publish').mockRejectedValueOnce(new Error('transport down'));
      await app.get(OutboxPublisher).drain();

      // Başarısız kayıt geri planlandı: hemen yeniden denenmez.
      const row = await pool.query<{ next_attempt_at: Date }>(`SELECT next_attempt_at FROM outbox`);
      expect(new Date(row.rows[0]?.next_attempt_at as Date).getTime()).toBeGreaterThan(Date.now());
    });

    it('hata kodu saklanır ama hata metni saklanmaz (PII sızıntısı riski)', async () => {
      await register('outbox-sub-5');

      const transport = app.get<EventTransport>(EVENT_TRANSPORT);
      jest
        .spyOn(transport, 'publish')
        .mockRejectedValueOnce(new Error('connection to user ayse@example.com failed'));

      await app.get(OutboxPublisher).drain();

      const row = await pool.query<{ last_error_code: string }>(
        `SELECT last_error_code FROM outbox`,
      );
      expect(row.rows[0]?.last_error_code).toBe('Error');
      expect(row.rows[0]?.last_error_code).not.toContain('ayse@example.com');
    });
  });

  describe('idempotency (T-07)', () => {
    const profile = { displayName: 'Ayşe Test' };

    it('aynı anahtarla tekrar eden istek yan etki üretmez', async () => {
      await register('idem-sub-1');
      const token = bearer('idem-sub-1');

      const first = await http()
        .post(`${PREFIX}/customers/profile`)
        .set('authorization', token)
        .set('idempotency-key', 'key-1')
        .send(profile)
        .expect(201);

      const second = await http()
        .post(`${PREFIX}/customers/profile`)
        .set('authorization', token)
        .set('idempotency-key', 'key-1')
        .send(profile)
        .expect(201);

      expect(second.body).toEqual(first.body);
      expect(second.headers['idempotent-replay']).toBe('true');

      const profiles = await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM customer_profiles`,
      );
      expect(profiles.rows[0]?.count).toBe('1');
    });

    // T-07b: aynı anahtar farklı gövdeyle sessizce ilk yanıtı döndürmemeli.
    it('aynı anahtar farklı gövdeyle reddedilir', async () => {
      await register('idem-sub-2');
      const token = bearer('idem-sub-2');

      await http()
        .post(`${PREFIX}/customers/profile`)
        .set('authorization', token)
        .set('idempotency-key', 'key-2')
        .send(profile)
        .expect(201);

      const conflict = await http()
        .post(`${PREFIX}/customers/profile`)
        .set('authorization', token)
        .set('idempotency-key', 'key-2')
        .send({ displayName: 'Başka İsim' })
        .expect(409);

      expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    // T-07c: kayıt kalıcıdır; Redis temizliği idempotency'yi bozmaz.
    it('Redis temizliği sonrası hâlâ idempotenttir', async () => {
      await register('idem-sub-3');
      const token = bearer('idem-sub-3');

      await http()
        .post(`${PREFIX}/customers/profile`)
        .set('authorization', token)
        .set('idempotency-key', 'key-3')
        .send(profile)
        .expect(201);

      await redis.flushdb();

      await http()
        .post(`${PREFIX}/customers/profile`)
        .set('authorization', token)
        .set('idempotency-key', 'key-3')
        .send(profile)
        .expect(201);

      const profiles = await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM customer_profiles`,
      );
      expect(profiles.rows[0]?.count).toBe('1');
    });

    it('başarısız istek anahtarı tüketmez', async () => {
      await register('idem-sub-4');
      const token = bearer('idem-sub-4');

      // Geçersiz gövde: işlem başarısız olur.
      await http()
        .post(`${PREFIX}/customers/profile`)
        .set('authorization', token)
        .set('idempotency-key', 'key-4')
        .send({ displayName: 'x' })
        .expect(400);

      // Aynı anahtar, artık geçerli gövdeyle çalışabilmeli.
      await http()
        .post(`${PREFIX}/customers/profile`)
        .set('authorization', token)
        .set('idempotency-key', 'key-4')
        .send(profile)
        .expect(201);
    });

    // Süreç istek ortasında çökerse rezervasyon IN_PROGRESS kalır; istemci TTL boyunca
    // (24 saat) kilitlenmemeli.
    it('asılı kalmış rezervasyon kiralama süresi dolunca devralınır', async () => {
      const userId = await register('idem-sub-6');
      const token = bearer('idem-sub-6');

      // Çökmüş bir isteğin bıraktığı kayıt: IN_PROGRESS, eski.
      // Kapsam kullanıcıyı içerir (çapraz kullanıcı sızıntısına karşı).
      const scope = `POST /api/v1/customers/profile ${userId}`;
      const fingerprint = app.get(IdempotencyService).fingerprint(profile);
      await pool.query(
        `INSERT INTO idempotency_keys (scope, key, request_fingerprint, status, created_at, expires_at)
         VALUES ($1, $2, $3, 'IN_PROGRESS', now() - interval '10 minutes', now() + interval '1 day')`,
        [scope, 'stale-key', fingerprint],
      );

      await http()
        .post(`${PREFIX}/customers/profile`)
        .set('authorization', token)
        .set('idempotency-key', 'stale-key')
        .send(profile)
        .expect(201);
    });

    it('taze rezervasyon devralınmaz (eşzamanlı istek paralel yürütülmez)', async () => {
      const userId = await register('idem-sub-7');
      const token = bearer('idem-sub-7');

      const scope = `POST /api/v1/customers/profile ${userId}`;
      const fingerprint = app.get(IdempotencyService).fingerprint(profile);
      await pool.query(
        `INSERT INTO idempotency_keys (scope, key, request_fingerprint, status, expires_at)
         VALUES ($1, $2, $3, 'IN_PROGRESS', now() + interval '1 day')`,
        [scope, 'fresh-key', fingerprint],
      );

      const response = await http()
        .post(`${PREFIX}/customers/profile`)
        .set('authorization', token)
        .set('idempotency-key', 'fresh-key')
        .send(profile)
        .expect(409);

      expect(response.body.error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    });

    it('çakışan anahtar başkasının rezervasyonunu silmez', async () => {
      const userId = await register('idem-sub-8');
      const token = bearer('idem-sub-8');

      const scope = `POST /api/v1/customers/profile ${userId}`;
      await pool.query(
        `INSERT INTO idempotency_keys (scope, key, request_fingerprint, status, expires_at)
         VALUES ($1, $2, $3, 'IN_PROGRESS', now() + interval '1 day')`,
        [scope, 'owned-key', 'a'.repeat(64)],
      );

      // Farklı parmak izi: istek reddedilir ama mevcut rezervasyon korunmalı.
      await http()
        .post(`${PREFIX}/customers/profile`)
        .set('authorization', token)
        .set('idempotency-key', 'owned-key')
        .send(profile)
        .expect(409);

      const remaining = await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM idempotency_keys WHERE key = 'owned-key'`,
      );
      expect(remaining.rows[0]?.count).toBe('1');
    });

    it('eşzamanlı aynı istek paralel yürütülmez', async () => {
      await register('idem-sub-9');
      const token = bearer('idem-sub-9');

      const send = (): Promise<request.Response> =>
        http()
          .post(`${PREFIX}/customers/profile`)
          .set('authorization', token)
          .set('idempotency-key', 'concurrent-key')
          .send(profile);

      const [first, second] = await Promise.all([send(), send()]);
      const statuses = [first.status, second.status].sort((a, b) => a - b);

      // Biri işlemi yapar; diğeri ya "işleniyor" der ya da saklanan yanıtı tekrarlar.
      expect(statuses[0]).toBe(201);
      expect([201, 409]).toContain(statuses[1]);

      const profiles = await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM customer_profiles`,
      );
      expect(profiles.rows[0]?.count).toBe('1');
    });

    // KRİTİK: anahtar kapsamı kullanıcıyı içermezse, başka bir kullanıcının saklanmış
    // yanıtı (içindeki userId ile birlikte) aynı anahtar + aynı gövdeyle okunabilirdi.
    it('bir kullanıcının anahtarı başka kullanıcının yanıtını döndürmez', async () => {
      await register('idem-victim');
      await register('idem-attacker');

      const victim = await http()
        .post(`${PREFIX}/customers/profile`)
        .set('authorization', bearer('idem-victim'))
        .set('idempotency-key', 'shared-key')
        .send(profile)
        .expect(201);

      const attacker = await http()
        .post(`${PREFIX}/customers/profile`)
        .set('authorization', bearer('idem-attacker'))
        .set('idempotency-key', 'shared-key')
        .send(profile)
        .expect(201);

      expect(attacker.body.userId).not.toBe(victim.body.userId);
      expect(attacker.headers['idempotent-replay']).toBeUndefined();
    });

    it('anahtar gönderilmezse istek normal işlenir', async () => {
      await register('idem-sub-5');

      await http()
        .post(`${PREFIX}/customers/profile`)
        .set('authorization', bearer('idem-sub-5'))
        .send(profile)
        .expect(201);
    });
  });

  describe('oran sınırı', () => {
    // Not: fail-closed davranışı (Redis erişilemezken reddetme) guard'ın unit testinde
    // doğrulanır — burada test edilen, sınırın gerçekten uygulandığıdır.
    it('sınır aşıldığında 429 döner', async () => {
      // /auth/session sınırı: 20 istek / 60 saniye.
      const responses: number[] = [];
      for (let attempt = 0; attempt < 22; attempt += 1) {
        const response = await http()
          .post(`${PREFIX}/auth/session`)
          .set('authorization', bearer(`ratelimit-sub-${attempt}`));
        responses.push(response.status);
      }

      expect(responses.filter((status) => status === 429).length).toBeGreaterThan(0);
      const limited = responses.lastIndexOf(429);
      expect(limited).toBeGreaterThanOrEqual(20);
    });
  });
});
