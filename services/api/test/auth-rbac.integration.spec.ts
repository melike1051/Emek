import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import type Redis from 'ioredis';
import {
  PREFIX,
  auditActionsSince,
  bearer,
  clearRateLimits,
  createPool,
  createRedis,
  ensureCatalog,
  createTestApp,
  currentAuditMaxId,
  resetDomainTables,
} from './helpers/test-app';

/**
 * Kimlik doğrulama ve yetkilendirme davranışı (ADR-0013).
 *
 * Zorunlu senaryolar: T-30 (yetkisiz erişim / IDOR), T-31 (hata sızıntısı),
 * T-37 (guard'sız endpoint yok).
 */
describe('auth & RBAC (integration)', () => {
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

  describe('deny by default', () => {
    it('token olmadan korumalı endpoint 401 döner', async () => {
      const response = await http().get(`${PREFIX}/users/me`).expect(401);

      expect(response.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('geçersiz biçimli token 401 döner ve nedeni sızdırmaz', async () => {
      const response = await http()
        .get(`${PREFIX}/users/me`)
        .set('authorization', 'Bearer not-a-valid-token')
        .expect(401);

      expect(response.body.error.code).toBe('UNAUTHENTICATED');
      expect(JSON.stringify(response.body)).not.toContain('unsupported_token');
    });

    it('Bearer öneki olmayan authorization başlığı reddedilir', async () => {
      await http().get(`${PREFIX}/users/me`).set('authorization', 'mock:user-1').expect(401);
    });

    it('geçerli token ama Emek kullanıcısı yoksa 401 döner (önce session kurulmalı)', async () => {
      await http()
        .get(`${PREFIX}/users/me`)
        .set('authorization', bearer('never-registered'))
        .expect(401);
    });

    it('katalog herkese açıktır', async () => {
      await http().get(`${PREFIX}/service-categories`).expect(200);
      await http().get(`${PREFIX}/skills`).expect(200);
    });

    it('health herkese açıktır', async () => {
      await http().get(`${PREFIX}/health/live`).expect(200);
    });
  });

  describe('session kurulumu', () => {
    it('ilk çağrıda kullanıcı oluşturur ve CUSTOMER rolü verir', async () => {
      const auditFrom = await currentAuditMaxId(pool);

      const response = await http()
        .post(`${PREFIX}/auth/session`)
        .set('authorization', bearer('sub-new', { email: 'yeni@example.com' }))
        .expect(201);

      expect(response.body.registered).toBe(true);
      expect(response.body.roles).toEqual(['CUSTOMER']);
      expect(await auditActionsSince(pool, auditFrom)).toEqual(['USER_REGISTERED']);
    });

    it('ikinci çağrıda yeni kullanıcı oluşturmaz', async () => {
      await http()
        .post(`${PREFIX}/auth/session`)
        .set('authorization', bearer('sub-repeat'))
        .expect(201);
      const second = await http()
        .post(`${PREFIX}/auth/session`)
        .set('authorization', bearer('sub-repeat'))
        .expect(201);

      expect(second.body.registered).toBe(false);

      const users = await pool.query<{ count: string }>(`SELECT count(*)::text FROM users`);
      expect(users.rows[0]?.count).toBe('1');
    });

    it('iletişim bilgisi döndürmeyen token açık hata verir (500 değil)', async () => {
      const response = await http()
        .post(`${PREFIX}/auth/session`)
        .set('authorization', bearer('sub-no-contact', { noContact: true }))
        .expect(400);

      expect(response.body.error.code).toBe('AUTH_CONTACT_REQUIRED');

      const users = await pool.query<{ count: string }>(`SELECT count(*)::text FROM users`);
      expect(users.rows[0]?.count).toBe('0');
    });

    it('telefonla gelen token da kabul edilir', async () => {
      const response = await http()
        .post(`${PREFIX}/auth/session`)
        .set('authorization', bearer('sub-phone', { phone: '+905551119988' }))
        .expect(201);

      expect(response.body.registered).toBe(true);
    });

    // Aynı subject için iki eşzamanlı istek: biri kullanıcıyı oluşturur, diğeri
    // unique ihlaliyle 500 vermek yerine mevcut kullanıcıyı okur.
    it('eşzamanlı ilk oturum tek kullanıcı üretir', async () => {
      const send = (): Promise<request.Response> =>
        http().post(`${PREFIX}/auth/session`).set('authorization', bearer('sub-race'));

      const [first, second] = await Promise.all([send(), send()]);

      expect([first.status, second.status]).toEqual([201, 201]);
      expect(first.body.userId).toBe(second.body.userId);

      const users = await pool.query<{ count: string }>(`SELECT count(*)::text FROM users`);
      expect(users.rows[0]?.count).toBe('1');
    });

    it('token olmadan session kurulamaz', async () => {
      await http().post(`${PREFIX}/auth/session`).expect(401);
    });

    it('UserRegistered event.i outbox.a yazılır (aynı transaction)', async () => {
      await http()
        .post(`${PREFIX}/auth/session`)
        .set('authorization', bearer('sub-event'))
        .expect(201);

      const events = await pool.query<{ event_type: string; status: string }>(
        `SELECT event_type, status FROM outbox ORDER BY occurred_at`,
      );

      expect(events.rows.some((row) => row.event_type === 'UserRegistered')).toBe(true);
    });
  });

  describe('rol kontrolü', () => {
    async function register(subject: string): Promise<string> {
      const response = await http()
        .post(`${PREFIX}/auth/session`)
        .set('authorization', bearer(subject))
        .expect(201);
      return response.body.userId as string;
    }

    it('CUSTOMER rolü provider endpoint.ine erişemez', async () => {
      await register('sub-customer');

      const response = await http()
        .get(`${PREFIX}/providers/me`)
        .set('authorization', bearer('sub-customer'))
        .expect(403);

      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('provider profili oluşturduktan sonra PROVIDER endpoint.leri açılır', async () => {
      await register('sub-becomes-provider');

      await http()
        .post(`${PREFIX}/providers/profile`)
        .set('authorization', bearer('sub-becomes-provider'))
        .send({ displayName: 'Ayşe Y.' })
        .expect(201);

      const roles = await http()
        .get(`${PREFIX}/users/me/roles`)
        .set('authorization', bearer('sub-becomes-provider'))
        .expect(200);

      expect(roles.body.roles).toEqual(expect.arrayContaining(['CUSTOMER', 'PROVIDER']));

      await http()
        .get(`${PREFIX}/providers/me`)
        .set('authorization', bearer('sub-becomes-provider'))
        .expect(200);
    });

    it('askıya alınmış kullanıcı erişemez', async () => {
      const userId = await register('sub-suspended');
      await pool.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [userId]);

      const response = await http()
        .get(`${PREFIX}/users/me`)
        .set('authorization', bearer('sub-suspended'))
        .expect(403);

      expect(response.body.error.code).toBe('FORBIDDEN');
    });
  });

  // T-30: bir kullanıcının verisi başka kullanıcının token'ıyla erişilemez.
  describe('sahiplik (IDOR)', () => {
    it('her kullanıcı yalnızca kendi kaydını görür', async () => {
      await http().post(`${PREFIX}/auth/session`).set('authorization', bearer('sub-a')).expect(201);
      await http().post(`${PREFIX}/auth/session`).set('authorization', bearer('sub-b')).expect(201);

      const userA = await http()
        .get(`${PREFIX}/users/me`)
        .set('authorization', bearer('sub-a'))
        .expect(200);
      const userB = await http()
        .get(`${PREFIX}/users/me`)
        .set('authorization', bearer('sub-b'))
        .expect(200);

      expect(userA.body.id).not.toBe(userB.body.id);
    });

    it('bir kullanıcının güncellemesi diğerini etkilemez', async () => {
      await http().post(`${PREFIX}/auth/session`).set('authorization', bearer('sub-c')).expect(201);
      await http().post(`${PREFIX}/auth/session`).set('authorization', bearer('sub-d')).expect(201);

      await http()
        .patch(`${PREFIX}/users/me`)
        .set('authorization', bearer('sub-c'))
        .send({ email: 'yeni-adres@example.com' })
        .expect(200);

      // D'nin kaydı kendi kayıt anındaki değerinde kalır: C'nin güncellemesi ona dokunmaz.
      const userD = await http()
        .get(`${PREFIX}/users/me`)
        .set('authorization', bearer('sub-d'))
        .expect(200);
      expect(userD.body.email).toBe('sub-d@example.com');
    });

    it('bir sağlayıcı başka sağlayıcının yetkinliğini silemez', async () => {
      // İki sağlayıcı ve ortak bir yetkinlik.
      for (const subject of ['sub-p1', 'sub-p2']) {
        await http()
          .post(`${PREFIX}/auth/session`)
          .set('authorization', bearer(subject))
          .expect(201);
        await http()
          .post(`${PREFIX}/providers/profile`)
          .set('authorization', bearer(subject))
          .send({ displayName: `Sağlayıcı ${subject}` })
          .expect(201);
      }

      const skills = await http().get(`${PREFIX}/skills`).expect(200);
      const skillId = skills.body[0].id as string;

      await http()
        .post(`${PREFIX}/providers/me/skills`)
        .set('authorization', bearer('sub-p1'))
        .send({ skillId, level: 'EXPERT' })
        .expect(201);

      // p2, p1'in yetkinliğini silmeye çalışır: yol parametresi sahibi belirtmediği için
      // kendi profilinde bulunamaz ve 404 alır; p1'in kaydı bozulmaz.
      await http()
        .delete(`${PREFIX}/providers/me/skills/${skillId}`)
        .set('authorization', bearer('sub-p2'))
        .expect(404);

      const p1Skills = await http()
        .get(`${PREFIX}/providers/me/skills`)
        .set('authorization', bearer('sub-p1'))
        .expect(200);

      expect(p1Skills.body).toHaveLength(1);
    });
  });

  // T-31: hata gövdesi iç detay taşımaz.
  describe('hata sözleşmesi', () => {
    it('doğrulama hatası alan bilgisini yapısal olarak döner', async () => {
      await http()
        .post(`${PREFIX}/auth/session`)
        .set('authorization', bearer('sub-validate'))
        .expect(201);

      const response = await http()
        .patch(`${PREFIX}/users/me`)
        .set('authorization', bearer('sub-validate'))
        .send({ email: 'not-an-email' })
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.details.fields.join(' ')).toContain('email');
    });

    it('şemada olmayan alan reddedilir (whitelist)', async () => {
      await http()
        .post(`${PREFIX}/auth/session`)
        .set('authorization', bearer('sub-extra'))
        .expect(201);

      await http()
        .patch(`${PREFIX}/users/me`)
        .set('authorization', bearer('sub-extra'))
        .send({ email: 'ok@example.com', status: 'ADMIN' })
        .expect(400);
    });

    it('geçersiz UUID yol parametresi 400 döner, SQL hatası sızmaz', async () => {
      const response = await http().get(`${PREFIX}/services/not-a-uuid`).expect(400);

      expect(JSON.stringify(response.body)).not.toContain('invalid input syntax');
    });
  });
});
