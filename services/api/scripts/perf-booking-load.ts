/**
 * EXP-007 — Booking create yük ölçümü (Faz 14, S-02 / S-03 / S-04).
 *
 * Çalıştırma (yerel altyapı açık olmalı: `npm run infra:up`):
 *   npm run perf:booking --workspace=@emek/api
 *
 * **Yalnızca `_test` ile biten veritabanında çalışır** ve o veritabanının domain
 * tablolarını sıfırlar (integration testleriyle aynı koruma).
 *
 * Ne ölçülür: **local benchmark** — uygulama, veritabanı ve yük istemcisi aynı
 * makinede, Postgres emülasyonlu x86_64 container'da. Mutlak sayılar üretim
 * kapasitesi hakkında hiçbir şey söylemez; geçerli olan göreli karşılaştırmadır
 * (ölçek eğrisi, darboğaz sırası, before/after). Metrik tanımları ve limitations:
 * `docs/research/experiments/exp-007-performance-baseline.md`.
 *
 * Doğruluk, performansın yanında **birlikte** ölçülür: her seviyede overbooking ve
 * idempotency ihlali sayılır. Bu sayıların sıfırdan farklı olması, latency ne olursa
 * olsun bir başarısızlıktır.
 */

import { cpus, platform, release, totalmem } from 'node:os';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { POSTGRES_POOL } from '../src/common/database/database.tokens';
import { API_PREFIX } from '../src/common/api.constants';
import {
  bearer,
  createPool,
  createRedis,
  createTestApp,
  ensureCatalog,
  resetDomainTables,
} from '../test/helpers/test-app';

const OUTPUT = resolve(__dirname, '../../../docs/research/experiments/exp-007-booking-load.json');

/** Ölçülen eşzamanlılık seviyeleri (Faz 14 zorunlu kapsamı). */
const LEVELS = (process.env.PERF_LEVELS ?? '100,250,500').split(',').map((v) => Number(v.trim()));

/** İstemci tarafı kesme sınırı — `timeout rate` bu sınıra göre tanımlıdır. */
const CLIENT_TIMEOUT_MS = 10_000;

interface Sample {
  latencyMs: number;
  status: number | 'timeout' | 'transport-error';
  /** `idempotent-replay: true` → yanıt saklanmış yanıtın tekrarıdır. */
  replay?: boolean;
  /** Oluşan/dönen booking kimliği — aynı anahtarın tek kayda işaret ettiğini kanıtlar. */
  bookingId?: string;
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return Math.round((sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low)) * 10) / 10;
}

/**
 * Ölçüm penceresi: ilk isteğin gönderildiği an → son yanıtın alındığı an.
 * Ramp-up dahildir; ayrı bir "steady state" iddiası üretilmez (metrik tanımı §4).
 */
function summarize(samples: Sample[], windowMs: number) {
  const latencies = samples.map((s) => s.latencyMs);
  const count = (predicate: (s: Sample) => boolean): number => samples.filter(predicate).length;

  const created = count((s) => s.status === 201);
  const conflict = count((s) => s.status === 409);
  const rateLimited = count((s) => s.status === 429);
  const serverError = count((s) => typeof s.status === 'number' && s.status >= 500);
  const transport = count((s) => s.status === 'transport-error');
  const timeout = count((s) => s.status === 'timeout');

  // Yalnızca gerçekten rezervasyon oluşturan isteklerin gecikmesi.
  //
  // Toplam p50/p95 yanıltıcıdır: yüksek eşzamanlılıkta isteklerin çoğu **ucuz** 429
  // reddidir ve yüzdelikleri aşağı çeker; aynı nedenle ham RPS de asıl işin hızını
  // değil reddetme hızını ölçer. Bu yüzden 201'e özel yüzdelikler ve etkin
  // rezervasyon üretimi ayrıca raporlanır.
  const createdLatencies = samples.filter((s) => s.status === 201).map((s) => s.latencyMs);

  return {
    requests: samples.length,
    window_ms: Math.round(windowMs),
    rps: Math.round((samples.length / (windowMs / 1000)) * 10) / 10,
    created_p50_ms: quantile(createdLatencies, 0.5),
    created_p95_ms: quantile(createdLatencies, 0.95),
    created_p99_ms: quantile(createdLatencies, 0.99),
    created_per_second: Math.round((createdLatencies.length / (windowMs / 1000)) * 10) / 10,
    p50_ms: quantile(latencies, 0.5),
    p95_ms: quantile(latencies, 0.95),
    p99_ms: quantile(latencies, 0.99),
    max_ms: Math.round(Math.max(...latencies, 0) * 10) / 10,
    created,
    // 4xx hata değildir: 409 ve 429 sistemin doğru davranışıdır, ayrı raporlanır.
    conflict_409: conflict,
    rate_limited_429: rateLimited,
    // error rate = 5xx + taşıma hatası (metrik tanımı §4)
    error_rate: Math.round(((serverError + transport) / samples.length) * 10000) / 10000,
    server_error_5xx: serverError,
    transport_error: transport,
    timeout_rate: Math.round((timeout / samples.length) * 10000) / 10000,
    status_breakdown: samples.reduce<Record<string, number>>((acc, s) => {
      const key = String(s.status);
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

/** Redis `INFO stats` üzerinden pencere başı/sonu farkıyla hit rate. */
async function readRedisStats(redis: Redis): Promise<{ hits: number; misses: number }> {
  const info = await redis.info('stats');
  const read = (field: string): number => {
    const match = new RegExp(`^${field}:(\\d+)`, 'm').exec(info);
    return match === null ? 0 : Number(match[1]);
  };
  return { hits: read('keyspace_hits'), misses: read('keyspace_misses') };
}

function hitRate(
  before: { hits: number; misses: number },
  after: { hits: number; misses: number },
) {
  const hits = after.hits - before.hits;
  const misses = after.misses - before.misses;
  const total = hits + misses;
  return {
    hits,
    misses,
    hit_rate: total === 0 ? null : Math.round((hits / total) * 10000) / 10000,
  };
}

/**
 * Oran sınırı sayaçlarını temizler.
 *
 * **Ölçüm iskelesidir, korumanın zayıflatılması değildir.** IP bazlı sınır
 * (`booking-create`: 30/60 sn) tek kaynaklı bir yük istemcisi için ilk ve en sert
 * tavandır; sınır açıkken ölçülen şey booking motorunun kapasitesi değil, sayaçtır.
 * Bu yüzden her seviye **iki kez** ölçülür: sınır etkinken (gerçek tavan) ve sayaç
 * süpürülürken (altındaki motor kapasitesi). İkisi ayrı ayrı raporlanır.
 */
async function sweepRateLimits(redis: Redis): Promise<void> {
  await deleteByPrefix(redis, 'ratelimit:*');
}

/**
 * Ölçüm turları arasında Redis'te **yalnızca bu betiğin kirlettiği** anahtarları siler.
 *
 * Burada bilinçli olarak `flushdb()` **kullanılmaz** (Faz 14 security review):
 * betik yalnızca `DATABASE_URL_TEST`'in `_test` ile bittiğini doğrular; `REDIS_URL`
 * bağımsız bir değişkendir ve ayrı bir test Redis'i tanımlı değildir. `flushdb`,
 * doğru yapılandırılmış bir Postgres'e rağmen paylaşılan bir Redis'i silebilirdi.
 * Silinen üç önek, ölçümün gerçekten sıfırlaması gereken durumdur.
 */
async function resetMeasurementKeys(redis: Redis): Promise<void> {
  for (const pattern of ['ratelimit:*', 'idempotency:*', 'lock:*']) {
    await deleteByPrefix(redis, pattern);
  }
}

async function deleteByPrefix(redis: Redis, pattern: string): Promise<void> {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

interface Actor {
  token: string;
  providerId: string;
  addressId: string;
  slot: { start: string; end: string };
}

/**
 * Deterministik fixture üretimi.
 *
 * Rastgelelik yoktur: her aktörün kimliği, adresi ve zaman aralığı index'ten türetilir.
 * Aynı komut aynı veri kümesini üretir (reproducibility, §9).
 */
async function setup(
  baseUrl: string,
  redis: Redis,
  level: number,
  mode: 'distinct' | 'same-slot',
): Promise<Actor[]> {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + 1);

  const post = async (path: string, token: string, body?: unknown): Promise<Response> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`setup ${path} → ${response.status} ${await response.text()}`);
    }
    return response;
  };

  const servicesResponse = await fetch(`${baseUrl}/services`);
  const services = (await servicesResponse.json()) as { id: string }[];
  const serviceId = services[0]!.id;

  const windowStart = new Date(day);
  windowStart.setUTCHours(6, 0, 0, 0);
  const windowEnd = new Date(day);
  windowEnd.setUTCHours(22, 0, 0, 0);

  const actors: Actor[] = [];

  for (let index = 0; index < level; index += 1) {
    // Kurulum ölçülmez; sınır sayacı burada temizlenir ki fixture üretimi tavana
    // takılmasın. Ölçüm fazındaki davranış aşağıda ayrıca raporlanır.
    await sweepRateLimits(redis);
    const customerToken = bearer(`perf-c-${mode}-${level}-${index}`);
    const providerToken = bearer(`perf-p-${mode}-${level}-${index}`);

    await post('/auth/session', customerToken);
    const providerSession = await post('/auth/session', providerToken);
    const providerId = ((await providerSession.json()) as { userId: string }).userId;

    await post('/customers/profile', customerToken, { displayName: `Perf Müşteri ${index}` });
    await post('/providers/profile', providerToken, { displayName: `Perf Sağlayıcı ${index}` });

    const addressResponse = await post('/addresses', customerToken, {
      city: 'İstanbul',
      district: 'Kadıköy',
      line: `Perf Mahallesi ${index}. Sokak No 1`,
      latitude: 40.9909,
      longitude: 29.0303,
    });
    const addressId = ((await addressResponse.json()) as { id: string }).id;

    await post('/providers/me/availability', providerToken, {
      startsAt: windowStart.toISOString(),
      endsAt: windowEnd.toISOString(),
    });

    // `distinct`: her aktörün kendi sağlayıcısı ve kendi slot'u → çakışma beklenmez.
    // `same-slot`: tüm istekler **aynı** sağlayıcı + **aynı** aralık → tam olarak 1
    //              booking oluşmalı, gerisi 409 (S-03).
    const start = new Date(day);
    start.setUTCHours(7, 0, 0, 0);
    const slotStart = new Date(start.getTime() + (mode === 'same-slot' ? 0 : index * 60_000));
    const slotEnd = new Date(slotStart.getTime() + 30 * 60 * 1000);

    actors.push({
      token: customerToken,
      providerId: mode === 'same-slot' ? (actors[0]?.providerId ?? providerId) : providerId,
      addressId,
      slot: { start: slotStart.toISOString(), end: slotEnd.toISOString() },
    });
  }

  return actors.map((actor) => ({ ...actor, serviceId }) as Actor & { serviceId: string });
}

async function fire(
  baseUrl: string,
  actor: Actor & { serviceId: string },
  idempotencyKey?: string,
): Promise<Sample> {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/bookings`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: actor.token,
        'content-type': 'application/json',
        ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
      },
      body: JSON.stringify({
        providerId: actor.providerId,
        serviceId: actor.serviceId,
        addressId: actor.addressId,
        scheduledStart: actor.slot.start,
        scheduledEnd: actor.slot.end,
      }),
    });
    const text = await response.text();
    let bookingId: string | undefined;
    try {
      bookingId = (JSON.parse(text) as { id?: string }).id;
    } catch {
      bookingId = undefined;
    }
    return {
      latencyMs: performance.now() - started,
      status: response.status,
      replay: response.headers.get('idempotent-replay') === 'true',
      bookingId,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      latencyMs: performance.now() - started,
      status: aborted ? 'timeout' : 'transport-error',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Overbooking sayımı: aynı sağlayıcı için **çakışan** zaman aralığına sahip, iptal
 * edilmemiş booking çiftleri. Doğruluğun kaynağı DB constraint'idir; bu sorgu onun
 * gerçekten tuttuğunu bağımsız olarak doğrular.
 */
async function countOverbooking(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM bookings a
    JOIN bookings b
      ON a.provider_id = b.provider_id
     AND a.id < b.id
     AND a.scheduled_start < b.scheduled_end
     AND b.scheduled_start < a.scheduled_end
    WHERE a.status NOT IN ('CANCELLED') AND b.status NOT IN ('CANCELLED')
  `);
  return Number(result.rows[0]?.count ?? 0);
}

async function main(): Promise<void> {
  const testUrl = process.env.DATABASE_URL_TEST;
  if (testUrl === undefined || !new URL(testUrl).pathname.endsWith('_test')) {
    throw new Error("DATABASE_URL_TEST tanımlı ve '_test' ile biten bir veritabanı olmalı");
  }
  process.env.DATABASE_URL = testUrl;
  process.env.NODE_ENV = 'test';

  let app: INestApplication | undefined;
  let pool: Pool | undefined;
  let redis: Redis | undefined;

  try {
    app = await createTestApp();
    pool = createPool();
    redis = createRedis();
    const appPool = app.get<Pool>(POSTGRES_POOL);
    const baseUrl = `${await app.getUrl()}/${API_PREFIX}`.replace('[::1]', '127.0.0.1');

    const results: Record<string, unknown> = {};

    /** Tek bir ölçüm turu: sıfırla → fixture üret → eşzamanlı ateşle → topla. */
    const runBurst = async (
      level: number,
      mode: 'distinct' | 'same-slot',
      rateLimit: 'active' | 'swept',
    ) => {
      await resetDomainTables(pool!);
      await ensureCatalog(pool!);
      await resetMeasurementKeys(redis!);

      const actors = (await setup(baseUrl, redis!, level, mode)) as (Actor & {
        serviceId: string;
      })[];

      await sweepRateLimits(redis!);
      const redisBefore = await readRedisStats(redis!);

      let peakWaiting = 0;
      const poolWatcher = setInterval(() => {
        peakWaiting = Math.max(peakWaiting, appPool.waitingCount);
      }, 5);
      // 'swept' turunda sayaç ölçüm boyunca da temizlenir; bu, sınırın altındaki
      // motor kapasitesini görmek içindir ve sonuçta açıkça etiketlenir.
      const sweeper =
        rateLimit === 'swept' ? setInterval(() => void sweepRateLimits(redis!), 100) : undefined;

      const startedAt = performance.now();
      const samples = await Promise.all(actors.map((actor) => fire(baseUrl, actor)));
      const windowMs = performance.now() - startedAt;

      clearInterval(poolWatcher);
      if (sweeper !== undefined) clearInterval(sweeper);

      const redisAfter = await readRedisStats(redis!);
      const outbox = await pool!.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM outbox`,
      );
      const committed = await pool!.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM bookings WHERE status <> 'CANCELLED'`,
      );

      return {
        concurrency: level,
        rate_limit: rateLimit,
        ...summarize(samples, windowMs),
        committed_bookings: Number(committed.rows[0]?.count ?? 0),
        overbooking: await countOverbooking(pool!),
        pool: { max: appPool.options.max, peak_waiting: peakWaiting },
        redis: hitRate(redisBefore, redisAfter),
        outbox_rows: Number(outbox.rows[0]?.count ?? 0),
      };
    };

    // ---- S-02: artan eşzamanlılık, çakışmayan slotlar -------------------------
    const scaling = [];
    for (const level of LEVELS) {
      for (const rateLimit of ['active', 'swept'] as const) {
        scaling.push(await runBurst(level, 'distinct', rateLimit));
        process.stdout.write(`S-02 concurrency=${level} rateLimit=${rateLimit} tamamlandı\n`);
      }
    }
    results['s02_scaling'] = scaling;

    // ---- S-03: aynı provider + aynı slot -> tam olarak 1 booking --------------
    const contentionLevel = 100;
    await resetDomainTables(pool);
    await ensureCatalog(pool);
    await resetMeasurementKeys(redis);
    const contenders = (await setup(baseUrl, redis, contentionLevel, 'same-slot')) as (Actor & {
      serviceId: string;
    })[];
    await sweepRateLimits(redis);
    const contentionSweeper = setInterval(() => void sweepRateLimits(redis!), 100);
    const contentionStart = performance.now();
    const contentionSamples = await Promise.all(contenders.map((a) => fire(baseUrl, a)));
    const contentionWindow = performance.now() - contentionStart;
    clearInterval(contentionSweeper);
    const committed = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM bookings WHERE status <> 'CANCELLED'`,
    );
    results['s03_same_slot_contention'] = {
      concurrency: contentionLevel,
      ...summarize(contentionSamples, contentionWindow),
      committed_bookings: Number(committed.rows[0]?.count ?? 0),
      overbooking: await countOverbooking(pool),
    };
    process.stdout.write('S-03 tamamlandı\n');

    // ---- S-04: aynı idempotency key, eşzamanlı tekrar -------------------------
    await resetDomainTables(pool);
    await ensureCatalog(pool);
    await resetMeasurementKeys(redis);
    const [idemActor] = (await setup(baseUrl, redis, 1, 'distinct')) as (Actor & {
      serviceId: string;
    })[];
    const key = 'perf-idempotency-key-0001';
    await sweepRateLimits(redis);
    const idemSweeper = setInterval(() => void sweepRateLimits(redis!), 100);
    const idemStart = performance.now();
    const idemSamples = await Promise.all(
      Array.from({ length: 20 }, () => fire(baseUrl, idemActor!, key)),
    );
    const idemWindow = performance.now() - idemStart;
    clearInterval(idemSweeper);
    const idemBookings = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM bookings`,
    );
    results['s04_idempotency'] = {
      concurrent_repeats: idemSamples.length,
      ...summarize(idemSamples, idemWindow),
      bookings_created: Number(idemBookings.rows[0]?.count ?? 0),
      // Tasarlanmış sözleşme: 1 özgün 201, kalan 201'ler saklanmış yanıtın tekrarı
      // (`idempotent-replay: true`), eşzamanlı çakışmalar 409 IDEMPOTENCY_IN_PROGRESS.
      replayed_201: idemSamples.filter((s) => s.status === 201 && s.replay === true).length,
      original_201: idemSamples.filter((s) => s.status === 201 && s.replay !== true).length,
      distinct_booking_ids: new Set(
        idemSamples.filter((s) => s.bookingId !== undefined).map((s) => s.bookingId),
      ).size,
    };
    process.stdout.write('S-04 tamamlandı\n');

    const output = {
      experiment: 'EXP-007',
      label: 'local benchmark',
      generated_at: new Date().toISOString(),
      environment: {
        platform: `${platform()} ${release()}`,
        cpus: cpus().length,
        total_memory_gib: Math.round(totalmem() / 1024 ** 3),
        node: process.version,
        note: 'Postgres container x86_64, Apple silicon host üzerinde emülasyonlu. Uygulama, istemci ve veritabanı aynı makineyi paylaşır.',
      },
      metric_definitions: 'docs/research/experiments/exp-007-performance-baseline.md §4',
      client_timeout_ms: CLIENT_TIMEOUT_MS,
      results,
    };

    writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
    process.stdout.write(`Yazıldı: ${OUTPUT}\n`);
  } finally {
    await app?.close();
    await pool?.end();
    redis?.disconnect();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
