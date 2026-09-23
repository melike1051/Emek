import Redis from 'ioredis';
import { Pool } from 'pg';
import type { AppConfigService } from '../src/common/config/app-config.service';
import { HealthService } from '../src/health/health.service';

/** Bu test bağımlılık kontrollerini ölçer; sağlayıcı raporu sabit tutulur. */
const config = {
  env: {
    NODE_ENV: 'test',
    STORAGE_PROVIDER: 'mock',
    IDENTITY_HASH_KEY_SOURCE: 'env',
    EVENT_TRANSPORT_TYPE: 'logging',
    PUBSUB_EMULATOR_HOST: undefined,
    AUDIT_ARCHIVE_PROVIDER: 'memory',
    BIGQUERY_PROVIDER: 'mock',
    IDENTITY_PROVIDER: 'mock',
    PAYMENT_PROVIDER: 'mock',
    AUTH_PROVIDER: 'mock',
    APP_CHECK_ENABLED: false,
  },
} as unknown as AppConfigService;

/**
 * Bağımlılık arızası davranışı. Gerçek istemcilerle, ulaşılamayan adreslere karşı çalışır:
 * health check bir bağımlılık düştüğünde askıda kalmamalı, hızlı ve doğru rapor vermeli
 * (ADR-0003 — Redis kaybı uygulamayı düşürmez).
 */
/**
 * ioredis istemcisini kalıcı iz bırakmadan kapatır.
 *
 * `disconnect()` tek başına yeniden bağlanma zamanlayıcısını ve olay dinleyicilerini
 * bırakabiliyor; testler bittikten sonra bu handle'lar süreci ayakta tutuyordu
 * ("Jest did not exit"). Sızan handle, gerçek bir sızıntıyı gizleyebileceği için
 * göz ardı edilmiyor.
 */
function closeRedis(client: Redis): void {
  client.removeAllListeners();
  client.disconnect(false);
}

describe('health dependency failures (integration)', () => {
  const UNREACHABLE_REDIS = 'redis://127.0.0.1:1';
  const UNREACHABLE_POSTGRES = 'postgres://emek:emek@127.0.0.1:1/emek';

  it('ayakta olan Redis ilk komutta up raporlanır (bağlantı kurulurken reddedilmez)', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    const redis = new Redis(process.env.REDIS_URL as string, {
      enableOfflineQueue: true,
      maxRetriesPerRequest: 2,
      commandTimeout: 1000,
    });

    try {
      // İlk çağrı bilinçli olarak bağlantı kurulur kurulmaz yapılır: regresyon testi.
      const report = await new HealthService(pool, redis, config).check();

      expect(report.checks.redis.status).toBe('up');
      expect(report.status).toBe('ok');
    } finally {
      await pool.end();
      closeRedis(redis);
    }
  });

  it('erişilemeyen Redis degraded üretir ve süreç ayakta kalır', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    const redis = new Redis(UNREACHABLE_REDIS, {
      enableOfflineQueue: true,
      maxRetriesPerRequest: 1,
      commandTimeout: 500,
      connectTimeout: 500,
      retryStrategy: () => null,
    });
    redis.on('error', () => undefined); // dinleyici olmadan 'error' süreci düşürür

    try {
      const report = await new HealthService(pool, redis, config).check();

      expect(report.status).toBe('degraded');
      expect(report.checks.redis.status).toBe('down');
      expect(report.checks.postgres.status).toBe('up');
      // Arıza nedeni sınıflandırılmış etiket; ham adres/hata mesajı sızmaz.
      expect(['unreachable', 'timeout']).toContain(report.checks.redis.reason);
      expect(JSON.stringify(report)).not.toContain('127.0.0.1');
    } finally {
      await pool.end();
      closeRedis(redis);
    }
  });

  it('erişilemeyen Postgres degraded üretir ve health çağrısı askıda kalmaz', async () => {
    const pool = new Pool({
      connectionString: UNREACHABLE_POSTGRES,
      max: 2,
      connectionTimeoutMillis: 500,
    });
    const redis = new Redis(process.env.REDIS_URL as string, {
      enableOfflineQueue: true,
      maxRetriesPerRequest: 2,
      commandTimeout: 1000,
    });

    try {
      const startedAt = Date.now();
      const report = await new HealthService(pool, redis, config).check();

      expect(report.status).toBe('degraded');
      expect(report.checks.postgres.status).toBe('down');
      expect(report.checks.postgis.status).toBe('down');
      expect(report.checks.redis.status).toBe('up');
      // Health endpoint'i orchestrator tarafından çağrılır: sınırlı sürede dönmeli.
      expect(Date.now() - startedAt).toBeLessThan(5000);
    } finally {
      await pool.end().catch(() => undefined);
      closeRedis(redis);
    }
  });
});
