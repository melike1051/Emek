/**
 * EXP-007 — Safety telemetri yük profili (Faz 14, S-07 / S-08; R-64, R-66).
 *
 * Çalıştırma (yerel altyapı açık olmalı: `npm run infra:up`):
 *   npm run perf:safety-load --workspace=@emek/api
 *
 * **Yalnızca `_test` ile biten veritabanında çalışır** ve domain tablolarını sıfırlar.
 *
 * EXP-004'ün gecikme ölçümünden farkı: orası **tek istemcili** gecikmeyi ölçüyordu ve
 * açıkça "yük testi değildir" diyordu (R-64). Burada ölçülen, telemetrinin **hacim ve
 * eşzamanlılık** altındaki davranışıdır.
 *
 * Etiket: **local benchmark** (uygulama, veritabanı ve istemci aynı makinede;
 * Postgres emülasyonlu x86_64).
 */

import { cpus, platform, release } from 'node:os';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { safetyFixtures } from '../test/helpers/safety-fixtures';
import {
  PREFIX,
  clearRateLimits,
  createPool,
  createRedis,
  createTestApp,
  ensureCatalog,
  resetDomainTables,
} from '../test/helpers/test-app';

const OUTPUT = resolve(__dirname, '../../../docs/research/experiments/exp-007-safety-load.json');

/** Eşzamanlı telemetri gönderen oturum sayısı. */
const SESSIONS_PER_PHASE = Number(process.env.PERF_SAFETY_SESSIONS ?? '20');
/** Denenecek paket boyutları (uç, paket başına ≤ 20 örnek kabul eder). */
const BATCH_SIZES = [1, 5, 10, 20];

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
    max_ms: Math.round(Math.max(...values, 0) * 10) / 10,
  };
}

async function main(): Promise<void> {
  const testUrl = process.env.DATABASE_URL_TEST;
  if (testUrl === undefined || !new URL(testUrl).pathname.endsWith('_test')) {
    throw new Error("DATABASE_URL_TEST tanımlı ve '_test' ile biten bir veritabanı olmalı");
  }
  process.env.DATABASE_URL = testUrl;
  process.env.NODE_ENV = 'test';
  process.env.SAFETY_MONITOR_ENABLED = 'false';
  // Anomali servisi bilinçli olarak erişilemez: paniğin ve telemetrinin ondan
  // bağımsız olduğu, bozulmuş modda ölçülür (ADR-0008 §3).
  process.env.AI_SERVICE_URL = 'http://127.0.0.1:9';
  // Telemetri asgari aralığı **desteklenen en küçük değerine** (5 sn, şema sınırı)
  // ayarlanır.
  //
  // Neden: örnekler oturum başlangıcından sonra ve en fazla `max_skew` (120 sn)
  // ileride olabilir. Taze bir oturumda varsayılan 30 sn aralıkla pencereye yalnızca
  // ~4 örnek sığar; 20'lik paket ölçülemez. 5 sn ile 20 örnek 100 sn'ye yayılır ve
  // pencereye sığar. Bu, **kabul kriterini** değiştirir — paket başına yazma
  // maliyetini (tek INSERT + tek UPDATE) değiştirmez, ki ölçülen de odur.
  process.env.SAFETY_TELEMETRY_INTERVAL_SECONDS = '5';

  const pool: Pool = createPool();
  const redis = createRedis();
  let app: INestApplication | undefined;

  try {
    await resetDomainTables(pool);
    await clearRateLimits(redis);
    await ensureCatalog(pool);

    app = await createTestApp();
    const fx = safetyFixtures(
      () => app!,
      () => pool,
    );

    /**
     * Telemetri zaman bütçesi (oturum başına):
     *   asgari aralık 30 sn, azami yaş 900 sn → pencereye **~30 örnek** sığar.
     *
     * Bu yüzden her ölçüm fazı **taze oturumlarla** çalışır. İlk tasarımda tek bir
     * oturum kümesi bütün fazlarda kullanılıyordu; bütçe tükenince örnekler HTTP 200
     * alıp sessizce reddediliyor, ölçüm de yazma yerine reddetme maliyetini
     * ölçüyordu. Artık her faz kendi oturumlarını alır ve yazdığını doğrular.
     */
    const SPACING_SECONDS = 5;
    // Oturum **şimdi** açıldı: örnekler ondan sonra damgalanmalı (CAPTURED_BEFORE_SESSION)
    // ve en fazla 120 sn ileride olabilir. Saat bu yüzden şimdiden ileri sayar.
    const START_OFFSET_SECONDS = 0;

    const prepareSessions = async (tag: string, count: number) => {
      const made: { fixture: Awaited<ReturnType<typeof fx.setup>>; sessionId: string }[] = [];
      for (let index = 0; index < count; index += 1) {
        await clearRateLimits(redis);
        const fixture = await fx.setup(`${tag}-${index}`, 'CHECKED_IN');
        const session = await fx.sessionOf(fixture.bookingId);
        made.push({ fixture, sessionId: session.id as string });
      }
      await clearRateLimits(redis);
      process.stdout.write(`  ${tag}: ${count} oturum hazır\n`);
      return made;
    };

    const countRows = async (): Promise<number> =>
      Number(
        (await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM location_events`))
          .rows[0]!.count,
      );

    const results: Record<string, unknown> = {};

    // ---- S-07a: paket boyutu ölçeği (H-3) ------------------------------------
    //
    // İddia: telemetri ucu paket başına **tek INSERT + tek UPDATE** yapar; maliyet
    // paket boyutuyla doğrusal değil, paket başına yaklaşık sabittir.
    const batchProfile = [];
    for (const size of BATCH_SIZES) {
      const sessions = await prepareSessions(`s07a-${size}`, SESSIONS_PER_PHASE);
      const latencies: number[] = [];
      let accepted = 0;
      const before = await countRows();
      for (const { fixture, sessionId } of sessions) {
        const body = fx.batch(
          1,
          fx.clock(START_OFFSET_SECONDS, SPACING_SECONDS),
          Array.from({ length: size }, () => ({})),
        );
        const started = performance.now();
        const response = await fx.send(sessionId, fixture.providerToken, body).expect(200);
        latencies.push(performance.now() - started);
        accepted += (response.body as { accepted: number }).accepted;
      }
      const written = (await countRows()) - before;
      if (written === 0) {
        throw new Error(`S-07a paket=${size}: hiç satır yazılmadı — ölçüm anlamsız olurdu`);
      }
      const stats = summary(latencies);
      batchProfile.push({
        batch_size: size,
        ...stats,
        accepted_samples: accepted,
        rows_written: written,
        per_sample_p50_ms: Math.round((stats.p50_ms / size) * 100) / 100,
      });
      process.stdout.write(
        `S-07a paket=${size} p50=${stats.p50_ms}ms kabul=${accepted} satır=${written}\n`,
      );
    }
    results['s07a_batch_size'] = batchProfile;

    // ---- S-07b: eşzamanlı telemetri ------------------------------------------
    const concurrentSessions = await prepareSessions('s07b', SESSIONS_PER_PHASE);
    const beforeConcurrent = await countRows();
    const concurrentStart = performance.now();
    const concurrentLatencies = await Promise.all(
      concurrentSessions.map(async ({ fixture, sessionId }) => {
        const body = fx.batch(
          1,
          fx.clock(START_OFFSET_SECONDS, SPACING_SECONDS),
          Array.from({ length: 20 }, () => ({})),
        );
        const started = performance.now();
        const response = await fx.send(sessionId, fixture.providerToken, body);
        return {
          ms: performance.now() - started,
          status: response.status,
          accepted: (response.body as { accepted?: number }).accepted ?? 0,
        };
      }),
    );
    const concurrentWindow = performance.now() - concurrentStart;
    const writtenConcurrent = (await countRows()) - beforeConcurrent;
    if (writtenConcurrent === 0) {
      throw new Error('S-07b: hiç satır yazılmadı — ölçüm anlamsız olurdu');
    }
    const acceptedConcurrent = concurrentLatencies.reduce((sum, r) => sum + r.accepted, 0);
    const concurrentSummary = {
      sessions: SESSIONS_PER_PHASE,
      batch_size: 20,
      window_ms: Math.round(concurrentWindow),
      ...summary(concurrentLatencies.filter((r) => r.status === 200).map((r) => r.ms)),
      http_ok: concurrentLatencies.filter((r) => r.status === 200).length,
      http_other: concurrentLatencies.filter((r) => r.status !== 200).length,
      accepted_samples: acceptedConcurrent,
      rows_written: writtenConcurrent,
      // Hız **kabul edilen** örnek üzerinden: reddedilen örnek yazma maliyeti
      // doğurmaz ve throughput gibi raporlanamaz.
      accepted_samples_per_second:
        Math.round((acceptedConcurrent / (concurrentWindow / 1000)) * 10) / 10,
    };
    results['s07b_concurrent'] = concurrentSummary;
    process.stdout.write(`S-07b p50=${concurrentSummary.p50_ms}ms satır=${writtenConcurrent}\n`);

    // ---- S-07c: partition davranışı (R-69) -----------------------------------
    const partitions = await pool.query<{ name: string; rows: string }>(`
      SELECT c.relname AS name, coalesce(s.n_live_tup, 0)::text AS rows
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
       WHERE i.inhparent = 'location_events'::regclass
       ORDER BY c.relname
    `);
    results['s07c_partitions'] = {
      note: 'DEFAULT partition’a düşen satır partition düşürmeyle temizlenemez (R-69).',
      partitions: partitions.rows.map((r) => ({ name: r.name, rows: Number(r.rows) })),
      default_partition_rows: Number(
        partitions.rows.find((r) => r.name.includes('default'))?.rows ?? 0,
      ),
    };

    // ---- S-08: panik yolu, telemetri yükü altında ----------------------------
    //
    // Panik deterministik ve hızlı kalmalıdır. Telemetri yükü **sürerken** panik
    // basılır; panik yolu değiştirilmeden ölçülür.
    const panicSessions = await prepareSessions('s08', SESSIONS_PER_PHASE);
    const panicUnderLoad: number[] = [];
    const loadRunning = Promise.all(
      panicSessions.map(async ({ fixture, sessionId }) => {
        const body = fx.batch(
          1,
          fx.clock(START_OFFSET_SECONDS, SPACING_SECONDS),
          Array.from({ length: 20 }, () => ({})),
        );
        await fx.send(sessionId, fixture.providerToken, body);
      }),
    );

    for (const { fixture, sessionId } of panicSessions.slice(0, 10)) {
      const started = performance.now();
      await fx
        .http()
        .post(`${PREFIX}/safety/sessions/${sessionId}/panic`)
        .set('authorization', fixture.customerToken)
        .send({})
        .expect(201);
      panicUnderLoad.push(performance.now() - started);
    }
    await loadRunning;

    results['s08_panic_under_load'] = {
      note: 'Telemetri yükü sürerken basılan panik; anomali servisi erişilemez (bozulmuş mod).',
      ...summary(panicUnderLoad),
    };
    process.stdout.write('S-08 tamamlandı\n');

    // ---- R-66: süreç içi telemetri oran sınırı -------------------------------
    //
    // Sınır **kimlik doğrulandıktan sonra**, kullanıcı başına ve **instance başına**
    // tutulur. Ölçülen yalnızca 429 davranışıdır: sınır, alan doğrulamasından önce
    // çalıştığı için örneklerin kabul edilip edilmemesi bu ölçümü etkilemez.
    const [limitProbe] = await prepareSessions('r66', 1);
    let accepted429 = 0;
    let limited = 0;
    for (let i = 0; i < 70; i += 1) {
      const body = fx.batch(i + 1, fx.clock(START_OFFSET_SECONDS, SPACING_SECONDS), [{}]);
      const response = await fx.send(
        limitProbe!.sessionId,
        limitProbe!.fixture.providerToken,
        body,
      );
      if (response.status === 429) limited += 1;
      else accepted429 += 1;
    }
    results['r66_process_local_rate_limit'] = {
      note: 'Süreç içi, kullanıcı başına 60/dk. Çok instance’ta toplam sınır N katıdır — R-66 açık kalır.',
      attempts: 70,
      passed_limiter: accepted429,
      rate_limited_429: limited,
    };
    process.stdout.write(`R-66 geçen=${accepted429} sınırlanan=${limited}\n`);

    const output = {
      experiment: 'EXP-007-safety',
      label: 'local benchmark',
      generated_at: new Date().toISOString(),
      environment: {
        platform: `${platform()} ${release()}`,
        cpus: cpus().length,
        node: process.version,
        anomaly_service: 'erişilemez (127.0.0.1:9) — bozulmuş mod',
        note: 'Postgres x86_64 emülasyonlu; uygulama/DB/istemci aynı makinede.',
      },
      results,
    };
    writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
    process.stdout.write(`Yazıldı: ${OUTPUT}\n`);
  } finally {
    await app?.close();
    await pool.end();
    redis.disconnect();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
