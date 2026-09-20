import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { HealthService } from './health.service';

/** Sorgu metnine göre davranan bir Pool taklidi: postgres ve postgis kontrolleri ayırt edilebilir. */
function createPool(behavior: {
  plain?: () => Promise<unknown>;
  postgis?: () => Promise<unknown>;
}) {
  const query = jest.fn((sql: string) =>
    sql.includes('postgis_version')
      ? (behavior.postgis ?? (() => Promise.resolve({ rows: [{ v: '3.4' }] })))()
      : (behavior.plain ?? (() => Promise.resolve({ rows: [{ v: 1 }] })))(),
  );

  return { pool: { query } as unknown as Pool, query };
}

function createRedis(ping?: () => Promise<unknown>) {
  const fn = jest.fn(ping ?? (() => Promise.resolve('PONG')));
  return { redis: { ping: fn } as unknown as Redis, ping: fn };
}

describe('HealthService', () => {
  it('tüm bağımlılıklar ayaktayken ok döner', async () => {
    const { pool } = createPool({});
    const { redis } = createRedis();

    const report = await new HealthService(pool, redis).check();

    expect(report.status).toBe('ok');
    expect(report.checks.postgres.status).toBe('up');
    expect(report.checks.postgis.status).toBe('up');
    expect(report.checks.redis.status).toBe('up');
  });

  it('Redis düştüğünde degraded döner ama Postgres durumunu bildirmeye devam eder', async () => {
    const { pool } = createPool({});
    const { redis } = createRedis(() => Promise.reject(new Error('ECONNREFUSED')));

    const report = await new HealthService(pool, redis).check();

    expect(report.status).toBe('degraded');
    expect(report.checks.redis.status).toBe('down');
    expect(report.checks.postgres.status).toBe('up');
  });

  // PostGIS extension'ı kurulmamışsa yalnızca bu kontrol düşer: bağlantı sağlamdır.
  it('PostGIS eksikse postgres up kalır, postgis down olur', async () => {
    const { pool } = createPool({
      postgis: () => Promise.reject(new Error('function postgis_version() does not exist')),
    });
    const { redis } = createRedis();

    const report = await new HealthService(pool, redis).check();

    expect(report.status).toBe('degraded');
    expect(report.checks.postgres.status).toBe('up');
    expect(report.checks.postgis.status).toBe('down');
  });

  it('Postgres bağlantısı düştüğünde her iki veritabanı kontrolü de down olur', async () => {
    const { pool } = createPool({
      plain: () => Promise.reject(new Error('connection terminated')),
      postgis: () => Promise.reject(new Error('connection terminated')),
    });
    const { redis } = createRedis();

    const report = await new HealthService(pool, redis).check();

    expect(report.checks.postgres.status).toBe('down');
    expect(report.checks.postgis.status).toBe('down');
  });

  it('arıza nedeni sınıflandırılmış etikettir, ham hata mesajı değildir', async () => {
    const { pool } = createPool({});
    const { redis } = createRedis(() =>
      Promise.reject(new Error('ECONNREFUSED 10.1.2.3:6379 user=admin')),
    );

    const report = await new HealthService(pool, redis).check();

    expect(report.checks.redis.reason).toBe('unreachable');
    expect(JSON.stringify(report)).not.toContain('10.1.2.3');
    expect(JSON.stringify(report)).not.toContain('admin');
  });

  it('yanıt vermeyen bağımlılıkta timeout ile döner, süresiz beklemez', async () => {
    const { pool } = createPool({});
    const { redis } = createRedis(() => new Promise(() => undefined));

    const report = await new HealthService(pool, redis).check();

    expect(report.checks.redis.status).toBe('down');
    expect(report.checks.redis.reason).toBe('timeout');
  }, 10000);

  it('kısa aralıklı tekrar çağrılarda bağımlılıklar yeniden yoklanmaz', async () => {
    const { pool, query } = createPool({});
    const { redis, ping } = createRedis();
    const service = new HealthService(pool, redis);

    await service.check();
    await service.check();

    // İlk turda 2 sorgu (plain + postgis) ve 1 ping; ikinci çağrı önbellekten döner.
    expect(query).toHaveBeenCalledTimes(2);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('eşzamanlı çağrılar tek yoklama turunu paylaşır', async () => {
    const { pool, query } = createPool({});
    const { redis } = createRedis();
    const service = new HealthService(pool, redis);

    await Promise.all([service.check(), service.check(), service.check()]);

    expect(query).toHaveBeenCalledTimes(2);
  });
});
