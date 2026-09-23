import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import type Redis from 'ioredis';
import { APP_CHECK_HEADER } from '../src/common/appcheck/app-check.guard';
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
 * Firebase App Check zorunluluğu (Faz 12, ADR-0022).
 *
 * Uygulama **App Check açıkken** kurulur: guard'ı değiştirmek yerine dünyayı
 * değiştirmek, testin gerçek kod yolunu ölçmesini sağlar. Doğrulayıcı `mock`'tur
 * (`appcheck:<appId>` biçimi); gerçek JWKS doğrulaması `FirebaseAppCheckVerifier`
 * içindedir ve production config'i mock'u reddeder.
 */
describe('App Check enforcement (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;

  const VALID = 'appcheck:emek-mobile';

  beforeAll(async () => {
    app = await createTestApp({
      env: { APP_CHECK_ENABLED: 'true', APP_CHECK_PROVIDER: 'mock' },
    });
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

  // Deny by default: işaretlenmemiş her rota token ister.
  it('App Check token olmadan korumalı rota reddedilir', async () => {
    const response = await http().get(`${PREFIX}/users/me`).expect(403);

    expect(response.body.error.code).toBe('APP_CHECK_REQUIRED');
  });

  it('geçersiz App Check token reddedilir ve nedeni sızdırmaz', async () => {
    const response = await http()
      .get(`${PREFIX}/users/me`)
      .set(APP_CHECK_HEADER, 'not-a-valid-app-check-token')
      .expect(403);

    expect(response.body.error.code).toBe('APP_CHECK_REQUIRED');
    expect(JSON.stringify(response.body)).not.toContain('malformed');
  });

  // App Check kimlikten ÖNCE çalışır: token'sız istek DB'ye hiç ulaşmamalı.
  it('App Check kimlik doğrulamasından önce çalışır', async () => {
    const response = await http()
      .get(`${PREFIX}/users/me`)
      .set('authorization', bearer('appcheck-user'))
      .expect(403);

    expect(response.body.error.code).toBe('APP_CHECK_REQUIRED');
  });

  it('geçerli App Check token ile akış normal devam eder', async () => {
    await http()
      .post(`${PREFIX}/auth/session`)
      .set(APP_CHECK_HEADER, VALID)
      .set('authorization', bearer('appcheck-user'))
      .expect(201);

    await http()
      .get(`${PREFIX}/users/me`)
      .set(APP_CHECK_HEADER, VALID)
      .set('authorization', bearer('appcheck-user'))
      .expect(200);
  });

  // App Check yetkilendirme DEĞİLDİR: geçen istek hâlâ AuthGuard'dan geçmek zorunda.
  it('geçerli App Check token kimlik doğrulamasının yerine geçmez', async () => {
    const response = await http()
      .get(`${PREFIX}/users/me`)
      .set(APP_CHECK_HEADER, VALID)
      .expect(401);

    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  describe('istisnalar (@SkipAppCheck)', () => {
    // Bu uçları çağıran mobil uygulama değil, altyapı/sağlayıcıdır: App Check
    // token'ı hiçbir zaman taşıyamazlar.
    it('health probe App Check istemez', async () => {
      await http().get(`${PREFIX}/health/live`).expect(200);
    });

    it('ödeme webhook uçu App Check yerine imza modelini kullanır', async () => {
      const response = await http()
        .post(`${PREFIX}/payments/webhook`)
        .send({ type: 'payment.authorized' });

      // İmzasız çağrı reddedilir ama gerekçe App Check değildir: istek guard'ı geçmiş,
      // imza doğrulamasına ulaşmıştır.
      expect(response.status).not.toBe(200);
      expect(response.body.error?.code).not.toBe('APP_CHECK_REQUIRED');
    });

    it('kimlik callback uçu App Check yerine imza modelini kullanır', async () => {
      const response = await http()
        .post(`${PREFIX}/verification/callback`)
        .send({ sessionId: 'x' });

      expect(response.body.error?.code).not.toBe('APP_CHECK_REQUIRED');
    });
  });
});
