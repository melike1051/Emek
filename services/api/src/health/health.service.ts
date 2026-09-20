import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { REDIS_CLIENT } from '../common/cache/redis.module';
import { POSTGRES_POOL } from '../common/database/database.module';

export type DependencyStatus = 'up' | 'down';

export interface DependencyCheck {
  status: DependencyStatus;
  latencyMs: number;
  /** Arıza nedeni: sabit, sınıflandırılmış bir etiket — ham hata mesajı değil. */
  reason?: string;
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  checks: {
    postgres: DependencyCheck;
    postgis: DependencyCheck;
    redis: DependencyCheck;
  };
}

const CHECK_TIMEOUT_MS = 2000;

/**
 * Health yanıtı kısa süre önbelleklenir. Endpoint kimlik doğrulaması gerektirmez ve
 * her çağrı bağlantı havuzundan bağlantı alır; önbellek olmadan sık çağrı (veya kasıtlı
 * istek seli) havuzu tüketip gerçek trafiği etkileyebilir.
 */
const CACHE_TTL_MS = 1000;

@Injectable()
export class HealthService {
  private cached?: { report: HealthReport; expiresAt: number };
  private inFlight?: Promise<HealthReport>;

  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async check(): Promise<HealthReport> {
    const now = Date.now();
    if (this.cached !== undefined && this.cached.expiresAt > now) {
      return this.cached.report;
    }

    // Eşzamanlı istekler tek bir kontrol turunu paylaşır.
    if (this.inFlight !== undefined) {
      return this.inFlight;
    }

    this.inFlight = this.probeAll()
      .then((report) => {
        this.cached = { report, expiresAt: Date.now() + CACHE_TTL_MS };
        return report;
      })
      .finally(() => {
        this.inFlight = undefined;
      });

    return this.inFlight;
  }

  private async probeAll(): Promise<HealthReport> {
    const [postgres, postgis, redis] = await Promise.all([
      this.timed(() => this.pool.query('SELECT 1')),
      this.timed(() => this.pool.query('SELECT postgis_version()')),
      this.timed(() => this.redis.ping()),
    ]);

    const checks = { postgres, postgis, redis };
    const degraded = Object.values(checks).some((check) => check.status === 'down');

    return { status: degraded ? 'degraded' : 'ok', checks };
  }

  private async timed(probe: () => Promise<unknown>): Promise<DependencyCheck> {
    const startedAt = Date.now();
    try {
      await this.withTimeout(probe());
      return { status: 'up', latencyMs: Date.now() - startedAt };
    } catch (error) {
      return {
        status: 'down',
        latencyMs: Date.now() - startedAt,
        reason: error instanceof Error && error.message === 'timeout' ? 'timeout' : 'unreachable',
      };
    }
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
