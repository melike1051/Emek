import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { REDIS_CLIENT } from '../common/cache/redis.module';
import { AppConfigService } from '../common/config/app-config.service';
import { POSTGRES_POOL } from '../common/database/database.module';

export type DependencyStatus = 'up' | 'down';

export interface DependencyCheck {
  status: DependencyStatus;
  latencyMs: number;
  /** Arıza nedeni: sabit, sınıflandırılmış bir etiket — ham hata mesajı değil. */
  reason?: string;
}

/**
 * Hangi sağlayıcı **türlerinin** yapılandırıldığı.
 *
 * Deploy sonrası smoke testinin cevaplaması gereken soru "servis 200 dönüyor mu"
 * değil, "doğru şeyle mi ayağa kalktı"dır: mock storage veya `logging` event
 * transport'u ile ayağa kalkmış bir ortam, HTTP 200 döndüğü hâlde kanıt yazmaz
 * ve event yayınlamaz.
 *
 * Rapor **yapılandırmayı** okur, çalışan nesneyi değil. Aradaki boşluk iki yerden
 * kapatılır: (1) sağlayıcı seçimi tek bir yapılandırma alanından yapılır, (2) gerçek
 * adapter'lar başlatmada kendi altyapılarını doğrular ve yanlışsa servis hiç ayağa
 * kalkmaz (ADR-0023 §3). Yani "gcs yazıyor ama mock çalışıyor" mümkün değildir.
 *
 * Burada yalnızca sağlayıcı türleri vardır; bucket adı, anahtar adı, sır ve
 * **çalışan sürüm** yoktur: kimliksiz erişilebilen bir uçta commit SHA'sı yayınlamak,
 * saldırgana hedefin tam kod sürümünü verirdi. Revizyon yalnızca boot logundadır.
 */
export interface ProviderReport {
  environment: string;
  storage: string;
  identityHashKeySource: string;
  eventTransport: string;
  /** Emulator'a bağlı bir dağıtım "pubsub" görünmemeli: bu alan onu ayrı ayrı söyler. */
  pubsubEmulator: boolean;
  auditArchive: string;
  bigQuery: string;
  identity: string;
  payment: string;
  auth: string;
  appCheckEnabled: boolean;
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  checks: {
    postgres: DependencyCheck;
    postgis: DependencyCheck;
    redis: DependencyCheck;
  };
  providers: ProviderReport;
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
    private readonly config: AppConfigService,
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

    return { status: degraded ? 'degraded' : 'ok', checks, providers: this.providers() };
  }

  private providers(): ProviderReport {
    const env = this.config.env;
    return {
      environment: env.NODE_ENV,
      storage: env.STORAGE_PROVIDER,
      identityHashKeySource: env.IDENTITY_HASH_KEY_SOURCE,
      eventTransport: env.EVENT_TRANSPORT_TYPE,
      pubsubEmulator: env.PUBSUB_EMULATOR_HOST !== undefined,
      auditArchive: env.AUDIT_ARCHIVE_PROVIDER,
      bigQuery: env.BIGQUERY_PROVIDER,
      identity: env.IDENTITY_PROVIDER,
      payment: env.PAYMENT_PROVIDER,
      auth: env.AUTH_PROVIDER,
      appCheckEnabled: env.APP_CHECK_ENABLED,
    };
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
