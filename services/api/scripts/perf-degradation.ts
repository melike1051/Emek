/**
 * EXP-007 — Bozulma maliyeti (Faz 14, S-11).
 *
 * Çalıştırma (yerel altyapı açık; sağlıklı kol için AI servisi de ayakta olmalı):
 *   npm run infra:up
 *   cd services/ai && uv run uvicorn app.main:app --port 8000   # ayrı terminal
 *   npm run perf:degradation --workspace=@emek/api
 *
 * **Yalnızca `_test` ile biten veritabanında çalışır** ve domain tablolarını sıfırlar.
 *
 * Bozulma davranışının **doğruluğu** zaten testlerle kapsanıyor (matching T-16,
 * `degradation.integration.spec.ts`). Burada ölçülen o değil: bozulmanın **bedeli**.
 * Bir bağımlılık düştüğünde uç nokta hâlâ yanıt veriyor olabilir, ama kaç ms
 * pahalıya? Zaman aşımı bütçesi kullanıcıya doğrudan gecikme olarak yansır.
 *
 * Üç kol, aynı istek, aynı fikstür:
 *   - `healthy` : AI servisi ayakta ve yanıt veriyor.
 *   - `refused` : bağlantı **anında** reddediliyor (127.0.0.1:1). Ucuz arıza.
 *   - `stalled` : bağlantı **kabul ediliyor ama yanıt hiç gelmiyor** — bu betiğin
 *                 kendi açtığı, hiçbir şey yazmayan bir TCP dinleyicisi. Pahalı
 *                 arıza: istemci zaman aşımı bütçesinin tamamını bekler.
 *
 * `refused` ile `stalled` arasındaki fark, "bağımlılık düştü" ifadesinin tek bir şey
 * olmadığını gösterir: ölçülmesi gereken, hızlıca hata veren değil, **asılı kalan**
 * bağımlılıktır (aşırı yüklü bir pod bağlantıyı kabul eder ve yanıtlamaz).
 *
 * Yönlendirilemez bir adres (RFC 5737 192.0.2.1) bilinçli olarak **kullanılmadı**:
 * bu makinede Node'un `fetch`'i oraya ~35 ms'de "fetch failed" ile düşüyor (rota
 * yok), yani zaman aşımı bütçesi hiç harcanmıyor. Ölçmek istediğimiz şeyi ölçmeyen
 * bir kol, ölçüm değildir.
 *
 * Etiket: **local benchmark**.
 */

import { createServer, type Socket } from 'node:net';
import { cpus, platform, release } from 'node:os';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import request from 'supertest';
import type { MockIdentityProvider } from '../src/identity/mock-identity-provider';
import { IDENTITY_PROVIDER } from '../src/identity/identity-provider.port';
import {
  PREFIX,
  bearer,
  clearRateLimits,
  createPool,
  createRedis,
  createTestApp,
  ensureCatalog,
  resetDomainTables,
} from '../test/helpers/test-app';

const OUTPUT = resolve(__dirname, '../../../docs/research/experiments/exp-007-degradation.json');

/** Kol başına istek sayısı. Küçük tutulur: ölçülen darboğaz değil, zaman aşımı bütçesidir. */
const REQUESTS_PER_ARM = Number(process.env.PERF_DEGRADATION_REQUESTS ?? '16');
/** Sağlıklı AI servisi adresi. */
const HEALTHY_AI = process.env.PERF_AI_URL ?? 'http://127.0.0.1:8000';
/** Anında reddeden adres: hiçbir şeyin dinlemediği loopback portu. */
const REFUSED_AI = 'http://127.0.0.1:1';
/** Bağlantıyı kabul edip hiç yanıtlamayan yerel dinleyicinin portu (bu betik açar). */
const STALLED_PORT = Number(process.env.PERF_STALL_PORT ?? '8099');
/** Uygulamanın AI çağrılarına verdiği bütçe; ölçümün beklediği tavan budur. */
const AI_TIMEOUT_MS = '1000';

interface Arm {
  name: string;
  aiUrl: string;
}

const ARMS: Arm[] = [
  { name: 'healthy', aiUrl: HEALTHY_AI },
  { name: 'refused', aiUrl: REFUSED_AI },
  { name: 'stalled', aiUrl: `http://127.0.0.1:${STALLED_PORT}` },
];

/**
 * Bağlantıyı kabul eden ama **hiçbir zaman yanıtlamayan** TCP dinleyicisi.
 *
 * Soketler bilinçli olarak açık tutulur: kapatmak "bağlantı koptu" olurdu, ölçmek
 * istediğimiz ise yanıtın hiç gelmemesi.
 */
function startStalledServer(port: number): { close: () => Promise<void> } {
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
  });
  // Port meşgulse sessiz bir yakalanmamış hata yerine ne yapılacağını söyleyen bir
  // mesaj verilir: bu betiğin geri kalanı hatalarında açık, bu da öyle olmalı.
  server.on('error', (error: NodeJS.ErrnoException) => {
    throw new Error(
      `Asılı kalan dinleyici ${port} portunda açılamadı (${error.code ?? 'bilinmeyen'}). ` +
        'PERF_STALL_PORT ile başka bir port verin.',
    );
  });
  server.listen(port, '127.0.0.1');
  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return Math.round((sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low)) * 10) / 10;
}

function summary(values: number[]) {
  return {
    samples: values.length,
    p50_ms: quantile(values, 0.5),
    p95_ms: quantile(values, 0.95),
    max_ms: values.length === 0 ? 0 : Math.round(Math.max(...values) * 10) / 10,
  };
}

function tomorrow(hour: number): Date {
  const moment = new Date();
  moment.setUTCDate(moment.getUTCDate() + 1);
  moment.setUTCHours(hour, 0, 0, 0);
  return moment;
}

interface Fixture {
  customerToken: string;
  requestIds: string[];
}

/**
 * Bir sağlayıcı + N eşleştirme talebi kurar.
 *
 * Kurulum ölçülmez; `matching.integration.spec.ts` ile aynı gerçek uçlardan geçer
 * (onay/kimlik durumu SQL ile kurulur — ölçülen şey eşleştirme, onay akışı değil).
 */
async function setup(
  app: INestApplication,
  pool: Pool,
  redis: Redis,
  seed: string,
  count: number,
): Promise<Fixture> {
  const http = (): request.Agent => request(app.getHttpServer());
  const providerToken = bearer(`deg-p-${seed}`);
  const customerToken = bearer(`deg-c-${seed}`);

  await clearRateLimits(redis);

  const providerSession = await http()
    .post(`${PREFIX}/auth/session`)
    .set('authorization', providerToken)
    .expect(201);
  const providerId = providerSession.body.userId as string;
  await http().post(`${PREFIX}/auth/session`).set('authorization', customerToken).expect(201);

  await http()
    .post(`${PREFIX}/providers/profile`)
    .set('authorization', providerToken)
    .send({ displayName: `Bozulma Sağlayıcı ${seed}` })
    .expect(201);
  await http()
    .post(`${PREFIX}/customers/profile`)
    .set('authorization', customerToken)
    .send({ displayName: `Bozulma Müşteri ${seed}` })
    .expect(201);

  await pool.query(
    `UPDATE provider_profiles
        SET state = 'APPROVED', max_daily_bookings = 10, rating_avg = 4.6, rating_count = 20
      WHERE user_id = $1`,
    [providerId],
  );
  await pool.query(
    `INSERT INTO identity_records
       (user_id, verification_provider, provider_subject_id, identity_hash,
        hash_key_version, verification_level, verification_status, assurance_level, verified_at)
     VALUES ($1, 'mock', $2, $3, 'v1', 'PROVIDER_VERIFIED', 'VERIFIED', 'HIGH', now())`,
    [providerId, `deg-subject-${seed}`, seed.padEnd(64, '0').slice(0, 64)],
  );

  const service = await pool.query<{ id: string }>(
    `SELECT id FROM services WHERE slug = 'detayli-temizlik'`,
  );
  const serviceId = service.rows[0]!.id;
  const skill = await pool.query<{ id: string }>(
    `SELECT id FROM skills WHERE slug = 'derin-temizlik'`,
  );
  const skillId = skill.rows[0]!.id;

  await http()
    .post(`${PREFIX}/providers/me/services`)
    .set('authorization', providerToken)
    .send({ serviceId })
    .expect(201);
  await http()
    .post(`${PREFIX}/providers/me/skills`)
    .set('authorization', providerToken)
    .send({ skillId, level: 'EXPERT' })
    .expect(201);
  await pool.query(`UPDATE provider_skills SET verified = TRUE WHERE provider_id = $1`, [
    providerId,
  ]);
  await http()
    .post(`${PREFIX}/providers/me/service-areas`)
    .set('authorization', providerToken)
    .send({
      name: `Bölge ${seed}`,
      latitude: 40.9909,
      longitude: 29.0303,
      radiusMeters: 10_000,
    })
    .expect(201);
  await http()
    .post(`${PREFIX}/providers/me/availability`)
    .set('authorization', providerToken)
    .send({ startsAt: tomorrow(6).toISOString(), endsAt: tomorrow(20).toISOString() })
    .expect(201);

  const address = await http()
    .post(`${PREFIX}/addresses`)
    .set('authorization', customerToken)
    .send({
      city: 'İstanbul',
      district: 'Kadıköy',
      line: 'Bozulma Mahallesi 1. Sokak No 2',
      latitude: 40.9909,
      longitude: 29.0303,
    })
    .expect(201);

  const requestIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    await clearRateLimits(redis);
    const created = await http()
      .post(`${PREFIX}/booking-requests`)
      .set('authorization', customerToken)
      .send({
        serviceId,
        addressId: address.body.id,
        preferredStart: tomorrow(8).toISOString(),
        preferredEnd: tomorrow(18).toISOString(),
        durationMinutes: 180,
      })
      .expect(201);
    requestIds.push(created.body.id as string);
  }

  return { customerToken, requestIds };
}

async function main(): Promise<void> {
  const testUrl = process.env.DATABASE_URL_TEST;
  if (testUrl === undefined || !new URL(testUrl).pathname.endsWith('_test')) {
    throw new Error("DATABASE_URL_TEST tanımlı ve '_test' ile biten bir veritabanı olmalı");
  }
  process.env.DATABASE_URL = testUrl;
  process.env.NODE_ENV = 'test';
  process.env.SAFETY_MONITOR_ENABLED = 'false';

  const pool: Pool = createPool();
  const redis = createRedis();
  const results: Record<string, unknown> = {};
  const stalled = startStalledServer(STALLED_PORT);

  try {
    for (const arm of ARMS) {
      await resetDomainTables(pool);
      await clearRateLimits(redis);
      await ensureCatalog(pool);

      const app = await createTestApp({
        env: {
          AI_SERVICE_URL: arm.aiUrl,
          AI_SERVICE_TIMEOUT_MS: AI_TIMEOUT_MS,
          MATCHING_SERVICE_TIMEOUT_MS: AI_TIMEOUT_MS,
        },
      });

      try {
        const fixture = await setup(app, pool, redis, arm.name, REQUESTS_PER_ARM);

        const latencies: number[] = [];
        let degraded = 0;
        let ok = 0;
        let failed = 0;

        // İlk istek atılır (Faz 14 review, M-8): bağlantı havuzu, JIT ve ilk sorgu
        // planı bedeli ona yüklenir. Atılmazsa `healthy`/`refused` kollarının p95'i
        // kuyruğu değil ısınmayı ölçer (max 84 ms, p50 10 ms gibi bir dağılım).
        // `stalled` kolunda atılan istek **devre kesici sayacına da yazılır**; bu
        // bilinçlidir, sayaç zaten gerçek trafikte de ilk istekten itibaren işler.
        const [warmupId, ...measuredIds] = fixture.requestIds;
        if (warmupId !== undefined) {
          await clearRateLimits(redis);
          await request(app.getHttpServer())
            .post(`${PREFIX}/booking-requests/${warmupId}/match`)
            .set('authorization', fixture.customerToken)
            .send({});
        }

        for (const requestId of measuredIds) {
          await clearRateLimits(redis);
          const start = process.hrtime.bigint();
          const response = await request(app.getHttpServer())
            .post(`${PREFIX}/booking-requests/${requestId}/match`)
            .set('authorization', fixture.customerToken)
            .send({});
          const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
          latencies.push(elapsed);

          if (response.status >= 200 && response.status < 300) {
            ok += 1;
            if (response.body.degraded === true) degraded += 1;
          } else {
            failed += 1;
          }
        }

        const runs = await pool.query<{ algorithm_version: string; count: string }>(
          `SELECT algorithm_version, count(*)::text AS count
             FROM matching_runs GROUP BY algorithm_version`,
        );

        results[arm.name] = {
          ai_url: arm.aiUrl,
          ai_timeout_ms: Number(AI_TIMEOUT_MS),
          requests: measuredIds.length,
          warmup_discarded: warmupId === undefined ? 0 : 1,
          http_2xx: ok,
          http_error: failed,
          degraded_results: degraded,
          latency: summary(latencies),
          algorithm_versions: Object.fromEntries(
            runs.rows.map((row) => [row.algorithm_version, Number(row.count)]),
          ),
        };

        process.stdout.write(
          `${arm.name}: p50=${quantile(latencies, 0.5)}ms p95=${quantile(latencies, 0.95)}ms ` +
            `ok=${ok} degraded=${degraded}\n`,
        );
      } finally {
        await app.close();
      }
    }

    // --- Kimlik sağlayıcısı erişilemez ---
    //
    // AI'dan farkı: kimlik doğrulaması **fallback'i olmayan** bir bağımlılıktır.
    // Ölçülen, bozulmanın ucuz mu (hızlı ve açık bir hata) yoksa pahalı mı
    // (kullanıcıyı bekleten) olduğudur.
    await resetDomainTables(pool);
    await clearRateLimits(redis);
    await ensureCatalog(pool);

    const identityApp = await createTestApp();
    try {
      const provider = identityApp.get<MockIdentityProvider>(IDENTITY_PROVIDER);
      const token = bearer('deg-identity');
      await request(identityApp.getHttpServer())
        .post(`${PREFIX}/auth/session`)
        .set('authorization', token)
        .expect(201);

      provider.setUnavailable(true);
      const latencies: number[] = [];
      const statuses: Record<string, number> = {};
      for (let i = 0; i < REQUESTS_PER_ARM; i += 1) {
        await clearRateLimits(redis);
        const start = process.hrtime.bigint();
        const response = await request(identityApp.getHttpServer())
          .post(`${PREFIX}/verification/session`)
          .set('authorization', token)
          .send({ method: 'NFC_EID' });
        latencies.push(Number(process.hrtime.bigint() - start) / 1e6);
        statuses[String(response.status)] = (statuses[String(response.status)] ?? 0) + 1;
      }
      provider.setUnavailable(false);

      results['identity_provider_down'] = {
        requests: REQUESTS_PER_ARM,
        statuses,
        latency: summary(latencies),
        note: 'Kimlik doğrulamasının fallback’i yoktur: doğru davranış hızlı ve açık bir hatadır.',
      };
      process.stdout.write(`identity_down: ${JSON.stringify(statuses)}\n`);
    } finally {
      await identityApp.close();
    }

    const output = {
      experiment: 'EXP-007-degradation',
      label: 'local benchmark',
      generated_at: new Date().toISOString(),
      environment: {
        platform: `${platform()} ${release()}`,
        cpus: cpus().length,
        node: process.version,
        note:
          'Uygulama, veritabanı ve istemci aynı makinede; Postgres x86_64 emülasyonlu. ' +
          'Rota sağlayıcısı ölçülmedi: kayıtlı tek sağlayıcı yerel `haversine`, dış ' +
          'rota servisi henüz entegre değil (services/ai/app/routing/registry.py).',
      },
      results,
    };
    writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
    process.stdout.write(`Yazıldı: ${OUTPUT}\n`);
  } finally {
    await stalled.close();
    await pool.end();
    redis.disconnect();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
