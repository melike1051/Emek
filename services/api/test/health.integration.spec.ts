import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { API_PREFIX } from '../src/common/api.constants';
import {
  CLIENT_TRACE_HEADER,
  REQUEST_ID_HEADER,
} from '../src/common/logging/request-context.middleware';

/**
 * Health endpoint'lerini gerçek PostgreSQL ve Redis bağlantılarıyla doğrular.
 *
 * Uygulama `configureApp()` ile kurulur — yani üretimde çalışan prefix, validation ve
 * hata yönetimi yapılandırmasının aynısı test edilir, kopyası değil.
 * Altyapı için: repo kökünde `npm run infra:up`.
 */
describe('health endpoints (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('liveness bağımlılık kontrolü yapmadan 200 döner', async () => {
    const response = await request(app.getHttpServer())
      .get(`/${API_PREFIX}/health/live`)
      .expect(200);

    expect(response.body).toEqual({ status: 'ok' });
  });

  it('readiness Postgres, PostGIS ve Redis durumunu raporlar', async () => {
    const response = await request(app.getHttpServer()).get(`/${API_PREFIX}/health`).expect(200);

    expect(response.body.status).toBe('ok');
    expect(response.body.checks.postgres.status).toBe('up');
    expect(response.body.checks.postgis.status).toBe('up');
    expect(response.body.checks.redis.status).toBe('up');
  });

  it('her yanıt sunucuda üretilmiş bir request id taşır', async () => {
    const response = await request(app.getHttpServer())
      .get(`/${API_PREFIX}/health/live`)
      .expect(200);

    expect(response.headers[REQUEST_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('istemci request id dayatamaz (audit izi korunur)', async () => {
    const response = await request(app.getHttpServer())
      .get(`/${API_PREFIX}/health/live`)
      .set(REQUEST_ID_HEADER, 'attacker-supplied-id')
      .set(CLIENT_TRACE_HEADER, 'client-trace-1')
      .expect(200);

    expect(response.headers[REQUEST_ID_HEADER]).not.toBe('attacker-supplied-id');
    expect(response.headers[REQUEST_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('bilinmeyen rota kodlu hata gövdesi döner, framework mesajı sızmaz', async () => {
    const response = await request(app.getHttpServer())
      .get(`/${API_PREFIX}/does-not-exist`)
      .expect(404);

    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.message).toBe('Kaynak bulunamadı.');
    expect(response.body.error.requestId).toBeDefined();
    expect(JSON.stringify(response.body)).not.toContain('Cannot GET');
  });

  it('readiness kısa süre önbelleklenir (havuz tüketimine karşı)', async () => {
    const first = await request(app.getHttpServer()).get(`/${API_PREFIX}/health`).expect(200);
    const second = await request(app.getHttpServer()).get(`/${API_PREFIX}/health`).expect(200);

    // Aynı rapor döner: ikinci istek yeni bağlantı açmaz.
    expect(second.body.checks.postgres.latencyMs).toBe(first.body.checks.postgres.latencyMs);
  });
});
