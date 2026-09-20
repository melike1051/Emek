import type { INestApplication } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import request from 'supertest';
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

/** Profil ve katalog akışları; audit kayıtlarının gerçekten yazıldığı da doğrulanır. */
describe('profiles & catalog (integration)', () => {
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

  describe('müşteri profili', () => {
    it('oluşturur, okur ve günceller', async () => {
      await register('cp-sub-1');
      const token = bearer('cp-sub-1');

      const created = await http()
        .post(`${PREFIX}/customers/profile`)
        .set('authorization', token)
        .send({ displayName: 'Zeynep K.', preferences: { petFriendly: true } })
        .expect(201);

      expect(created.body.displayName).toBe('Zeynep K.');
      expect(created.body.preferences).toEqual({ petFriendly: true });

      const read = await http()
        .get(`${PREFIX}/customers/me`)
        .set('authorization', token)
        .expect(200);
      expect(read.body.userId).toBe(created.body.userId);

      const updated = await http()
        .patch(`${PREFIX}/customers/me`)
        .set('authorization', token)
        .send({ displayName: 'Zeynep Kaya' })
        .expect(200);

      expect(updated.body.displayName).toBe('Zeynep Kaya');
      // Güncelleme tercihleri silmez (COALESCE davranışı).
      expect(updated.body.preferences).toEqual({ petFriendly: true });
    });

    it('ikinci kez oluşturmak reddedilir', async () => {
      await register('cp-sub-2');
      const token = bearer('cp-sub-2');

      await http()
        .post(`${PREFIX}/customers/profile`)
        .set('authorization', token)
        .send({ displayName: 'Ali V.' })
        .expect(201);

      const conflict = await http()
        .post(`${PREFIX}/customers/profile`)
        .set('authorization', token)
        .send({ displayName: 'Ali V.' })
        .expect(409);

      expect(conflict.body.error.code).toBe('PROFILE_ALREADY_EXISTS');
    });

    it('profil yoksa okuma 404 döner', async () => {
      await register('cp-sub-3');

      const response = await http()
        .get(`${PREFIX}/customers/me`)
        .set('authorization', bearer('cp-sub-3'))
        .expect(404);

      expect(response.body.error.code).toBe('PROFILE_NOT_FOUND');
    });

    it('boş görünen ad reddedilir', async () => {
      await register('cp-sub-4');

      await http()
        .post(`${PREFIX}/customers/profile`)
        .set('authorization', bearer('cp-sub-4'))
        .send({ displayName: ' ' })
        .expect(400);
    });

    it('işlemler audit.e yazılır', async () => {
      await register('cp-sub-5');
      const token = bearer('cp-sub-5');
      const auditFrom = await currentAuditMaxId(pool);

      await http()
        .post(`${PREFIX}/customers/profile`)
        .set('authorization', token)
        .send({ displayName: 'Audit Test' })
        .expect(201);
      await http()
        .patch(`${PREFIX}/customers/me`)
        .set('authorization', token)
        .send({ displayName: 'Audit Test 2' })
        .expect(200);

      expect(await auditActionsSince(pool, auditFrom)).toEqual([
        'CUSTOMER_PROFILE_CREATED',
        'CUSTOMER_PROFILE_UPDATED',
      ]);
    });
  });

  describe('sağlayıcı profili', () => {
    it('DRAFT durumunda oluşturulur (onay Faz 3.te)', async () => {
      await register('pp-sub-1');

      const created = await http()
        .post(`${PREFIX}/providers/profile`)
        .set('authorization', bearer('pp-sub-1'))
        .send({ displayName: 'Fatma D.', bio: 'On yıl deneyim', experienceYears: 10 })
        .expect(201);

      expect(created.body.state).toBe('DRAFT');
      expect(created.body.experienceYears).toBe(10);
      expect(created.body.ratingAvg).toBeNull();
      expect(created.body.ratingCount).toBe(0);
    });

    it('profil oluşturma PROVIDER rolünü verir ve audit.e yazılır', async () => {
      await register('pp-sub-2');
      const auditFrom = await currentAuditMaxId(pool);

      await http()
        .post(`${PREFIX}/providers/profile`)
        .set('authorization', bearer('pp-sub-2'))
        .send({ displayName: 'Hatice S.' })
        .expect(201);

      const actions = await auditActionsSince(pool, auditFrom);
      expect(actions).toEqual(['PROVIDER_PROFILE_CREATED', 'ROLE_GRANTED']);
    });

    it('geçersiz deneyim yılı reddedilir', async () => {
      await register('pp-sub-3');

      await http()
        .post(`${PREFIX}/providers/profile`)
        .set('authorization', bearer('pp-sub-3'))
        .send({ displayName: 'Test', experienceYears: 120 })
        .expect(400);
    });

    it('yetkinlik eklenir, listelenir ve silinir', async () => {
      await register('pp-sub-4');
      const token = bearer('pp-sub-4');
      await http()
        .post(`${PREFIX}/providers/profile`)
        .set('authorization', token)
        .send({ displayName: 'Yetkinlik Test' })
        .expect(201);

      const skills = await http().get(`${PREFIX}/skills`).expect(200);
      const skillId = skills.body[0].id as string;

      const added = await http()
        .post(`${PREFIX}/providers/me/skills`)
        .set('authorization', token)
        .send({ skillId, level: 'EXPERT' })
        .expect(201);

      expect(added.body).toHaveLength(1);
      expect(added.body[0].level).toBe('EXPERT');
      // Doğrulama Faz 3'e ait: eklenen yetkinlik doğrulanmamış başlar.
      expect(added.body[0].verified).toBe(false);

      const duplicate = await http()
        .post(`${PREFIX}/providers/me/skills`)
        .set('authorization', token)
        .send({ skillId, level: 'BEGINNER' })
        .expect(409);
      expect(duplicate.body.error.code).toBe('SKILL_ALREADY_ADDED');

      await http()
        .delete(`${PREFIX}/providers/me/skills/${skillId}`)
        .set('authorization', token)
        .expect(204);

      const after = await http()
        .get(`${PREFIX}/providers/me/skills`)
        .set('authorization', token)
        .expect(200);
      expect(after.body).toEqual([]);
    });

    it('var olmayan yetkinlik eklenemez', async () => {
      await register('pp-sub-5');
      const token = bearer('pp-sub-5');
      await http()
        .post(`${PREFIX}/providers/profile`)
        .set('authorization', token)
        .send({ displayName: 'Test' })
        .expect(201);

      await http()
        .post(`${PREFIX}/providers/me/skills`)
        .set('authorization', token)
        .send({ skillId: '00000000-0000-4000-8000-000000000000', level: 'EXPERT' })
        .expect(404);
    });

    it('geçersiz yetkinlik seviyesi reddedilir', async () => {
      await register('pp-sub-6');
      const token = bearer('pp-sub-6');
      await http()
        .post(`${PREFIX}/providers/profile`)
        .set('authorization', token)
        .send({ displayName: 'Test' })
        .expect(201);

      const skills = await http().get(`${PREFIX}/skills`).expect(200);

      await http()
        .post(`${PREFIX}/providers/me/skills`)
        .set('authorization', token)
        .send({ skillId: skills.body[0].id, level: 'GOD_MODE' })
        .expect(400);
    });
  });

  describe('katalog', () => {
    it('kategorileri listeler', async () => {
      const response = await http().get(`${PREFIX}/service-categories`).expect(200);

      expect(response.body.length).toBeGreaterThan(0);
      expect(response.body[0]).toEqual(
        expect.objectContaining({ slug: expect.any(String), name: expect.any(String) }),
      );
    });

    it('hizmetleri kategoriye göre filtreler', async () => {
      const all = await http().get(`${PREFIX}/services`).expect(200);
      const filtered = await http()
        .get(`${PREFIX}/services`)
        .query({ categorySlug: 'ev-temizligi' })
        .expect(200);

      expect(filtered.body.length).toBeGreaterThan(0);
      expect(filtered.body.length).toBeLessThan(all.body.length);
      expect(
        filtered.body.every(
          (service: { categorySlug: string }) => service.categorySlug === 'ev-temizligi',
        ),
      ).toBe(true);
    });

    it('geçersiz kategori filtresi reddedilir', async () => {
      await http().get(`${PREFIX}/services`).query({ categorySlug: 'Geçersiz Slug!' }).expect(400);
    });

    it('hizmet detayını döner', async () => {
      const services = await http().get(`${PREFIX}/services`).expect(200);
      const id = services.body[0].id as string;

      const detail = await http().get(`${PREFIX}/services/${id}`).expect(200);
      expect(detail.body.id).toBe(id);
    });

    it('pasif hizmet listelenmez ve detayı 404 döner', async () => {
      const services = await http().get(`${PREFIX}/services`).expect(200);
      const id = services.body[0].id as string;

      await pool.query(`UPDATE services SET active = FALSE WHERE id = $1`, [id]);
      try {
        await http().get(`${PREFIX}/services/${id}`).expect(404);

        const remaining = await http().get(`${PREFIX}/services`).expect(200);
        expect(remaining.body.some((service: { id: string }) => service.id === id)).toBe(false);
      } finally {
        await pool.query(`UPDATE services SET active = TRUE WHERE id = $1`, [id]);
      }
    });

    it('var olmayan hizmet 404 döner', async () => {
      await http().get(`${PREFIX}/services/00000000-0000-4000-8000-000000000000`).expect(404);
    });
  });
});
