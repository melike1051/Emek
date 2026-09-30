import type { INestApplication } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import request from 'supertest';
import {
  PREFIX,
  bearer,
  clearRateLimits,
  createPool,
  createRedis,
  createTestApp,
  currentAuditMaxId,
  resetDomainTables,
} from './helpers/test-app';

/**
 * Doğrulama oturumunun audit kaydındaki istemci adresi `resolveClientIp` ile çözülür (R-53),
 * `request.ip` ile değil. Bir güvenilen proxy hop'u (Cloud Run ön ucu) yapılandırıldığında
 * kaydedilen adres istemcininkidir; saldırganın eklediği sol baştaki adres değildir.
 */
describe('identity: istemci adresi (R-53, integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;

  beforeAll(async () => {
    app = await createTestApp({ env: { TRUSTED_PROXY_HOP_COUNT: '1' } });
    pool = createPool();
    redis = createRedis();
  });

  beforeEach(async () => {
    await resetDomainTables(pool);
    await clearRateLimits(redis);
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    redis?.disconnect();
  });

  it('audit ip_address = proxy’nin eklediği istemci adresi; sahte sol baş yok sayılır', async () => {
    const http = request(app.getHttpServer());
    await http.post(`${PREFIX}/auth/session`).set('authorization', bearer('ip-user')).expect(201);
    const since = await currentAuditMaxId(pool);

    await http
      .post(`${PREFIX}/verification/session`)
      .set('authorization', bearer('ip-user'))
      // İstemci "6.6.6.6" uydurdu; güvenilen proxy gördüğü adresi (203.0.113.7) sağa ekledi.
      .set('x-forwarded-for', '6.6.6.6, 203.0.113.7')
      .send({ method: 'NFC_EID' })
      .expect(201);

    const audit = await pool.query<{ ip: string }>(
      `SELECT host(ip_address) AS ip FROM audit_logs
        WHERE id > $1 AND action = 'IDENTITY_VERIFICATION_STARTED'`,
      [since],
    );
    expect(audit.rows).toEqual([{ ip: '203.0.113.7' }]);
  });
});
