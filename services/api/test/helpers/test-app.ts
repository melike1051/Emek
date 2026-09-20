import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { seedCatalog } from '../../scripts/seed-catalog';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { API_PREFIX } from '../../src/common/api.constants';

export const PREFIX = `/${API_PREFIX}`;

/**
 * Integration testleri için uygulama kurulumu.
 *
 * `configureApp()` kullanılır: prefix, validation ve hata yönetimi üretimdekiyle
 * aynıdır (Faz 1 review bulgusu). `AUTH_PROVIDER=mock` olduğu için token'lar
 * `mock:<subject>` biçiminde üretilir.
 */
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  configureApp(app);
  await app.init();
  return app;
}

export function createPool(): Pool {
  return new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
}

/**
 * Katalog referans verisinin var olduğunu garanti eder.
 *
 * Migration testi şemayı bilinçli olarak sıfırlar (`down 0` → `up`) ve seed verisini
 * siler. Katalog verisi test kodunda kopyalanmaz: üretim seed fonksiyonu kullanılır,
 * böylece testler gerçek referans veriye karşı çalışır.
 */
export async function ensureCatalog(pool: Pool): Promise<void> {
  await seedCatalog(pool);
}

export function createRedis(): Redis {
  return new Redis(process.env.REDIS_URL as string, {
    enableOfflineQueue: true,
    maxRetriesPerRequest: 2,
    commandTimeout: 1000,
  });
}

/**
 * Oran sınırı sayaçlarını temizler.
 *
 * Testler aynı IP'den çok sayıda istek gönderir; sayaç temizlenmezse gerçekten
 * çalışan oran sınırı (fail-closed, ADR-0003) testleri 429 ile düşürür.
 * Sınırın kendisi ayrı bir testte doğrulanır — burada yapılan, paylaşılan altyapı
 * durumunu izole etmektir, korumayı zayıflatmak değil.
 */
export async function clearRateLimits(redis: Redis): Promise<void> {
  const keys = await redis.keys('ratelimit:*');
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

/**
 * Mock doğrulayıcının anladığı token (bkz. MockTokenVerifier).
 *
 * Varsayılan olarak e-posta içerir: gerçek kimlik sağlayıcıları en az bir iletişim
 * kanalı döndürür ve `users_contact_present` bunu zorunlu kılar. İletişim bilgisiz
 * token davranışı ayrı bir testte doğrulanır.
 */
export function mockToken(
  subject: string,
  attributes: { email?: string; phone?: string; noContact?: boolean } = {},
): string {
  const parts = [`mock:${subject}`];
  if (
    attributes.noContact !== true &&
    attributes.email === undefined &&
    attributes.phone === undefined
  ) {
    parts.push(`email=${subject}@example.com`);
  }
  if (attributes.email !== undefined) {
    parts.push(`email=${attributes.email}`);
  }
  if (attributes.phone !== undefined) {
    parts.push(`phone=${attributes.phone}`);
  }
  return parts.join(':');
}

export function bearer(
  subject: string,
  attributes?: { email?: string; phone?: string; noContact?: boolean },
): string {
  return `Bearer ${mockToken(subject, attributes)}`;
}

/**
 * Domain tablolarını temizler.
 *
 * `audit_logs` TRUNCATE edilemez (append-only trigger — ADR-0013) ve edilmemelidir:
 * testler audit satırlarını id aralığıyla filtreleyerek kontrol eder.
 */
export async function resetDomainTables(pool: Pool): Promise<void> {
  // audit_logs bilinçli olarak FK taşımaz (append-only + KVKK silme), bu yüzden
  // users güvenle temizlenebilir; audit satırları tarihsel kayıt olarak kalır.
  await pool.query(`
    TRUNCATE TABLE provider_skills, provider_profiles, customer_profiles,
                   auth_subjects, user_roles, users, outbox, idempotency_keys, processed_events
    RESTART IDENTITY CASCADE;
  `);
}

export async function currentAuditMaxId(pool: Pool): Promise<number> {
  const result = await pool.query<{ max: string | null }>(
    `SELECT max(id)::text AS max FROM audit_logs`,
  );
  return Number(result.rows[0]?.max ?? 0);
}

export async function auditActionsSince(pool: Pool, sinceId: number): Promise<string[]> {
  const result = await pool.query<{ action: string }>(
    `SELECT action FROM audit_logs WHERE id > $1 ORDER BY id`,
    [sinceId],
  );
  return result.rows.map((row) => row.action);
}
