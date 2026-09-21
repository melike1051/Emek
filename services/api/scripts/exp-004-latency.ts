/**
 * EXP-004 (ek) — Veritabanına bağlı gecikme ölçümü: panik, telemetri, değerlendirme.
 *
 * Çalıştırma (yerel altyapı açık olmalı: `npm run infra:up`):
 *   npm run exp:safety:latency --workspace=@emek/api
 *
 * **Yalnızca `_test` ile biten veritabanında çalışır** ve o veritabanının domain
 * tablolarını sıfırlar (integration testleriyle aynı koruma).
 *
 * Ne ölçülür: tek istemcili ve düşük eşzamanlılıklı, **yerel geliştirme makinesinde**
 * (Docker Postgres/Redis) uçtan uca HTTP gecikmesi. Bir yük testi değildir ve üretim
 * kapasitesi hakkında hiçbir şey söylemez (R-64, Faz 14). Anomali servisi bilinçli
 * olarak erişilemez adrestedir: panik yolunun ondan bağımsız olduğu ve
 * değerlendirmenin bozulmuş modda tamamlandığı birlikte ölçülür.
 */

import { cpus, platform, release } from 'node:os';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { SafetyEvaluationService } from '../src/safety/safety-evaluation.service';
import { safetyFixtures } from '../test/helpers/safety-fixtures';
import {
  clearRateLimits,
  createPool,
  createRedis,
  createTestApp,
  ensureCatalog,
  resetDomainTables,
} from '../test/helpers/test-app';

const OUTPUT = resolve(__dirname, '../../../docs/research/experiments/exp-004-latency.json');
const SESSIONS = 30;
const PARALLEL_PANICS = 10;

function quantile(values: number[], q: number): number {
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
    max_ms: Math.round(Math.max(...values) * 10) / 10,
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
  process.env.AI_SERVICE_URL = 'http://127.0.0.1:9';

  // Yapılandırma modül yüklenirken değil, uygulama kurulurken okunur (AppConfigModule
  // factory'si); ortamı burada ayarlamak yeterlidir.
  const app = await createTestApp();
  const pool = createPool();
  const redis = createRedis();
  try {
    await resetDomainTables(pool);
    await clearRateLimits(redis);
    await ensureCatalog(pool);

    const fx = safetyFixtures(
      () => app,
      () => pool,
    );

    const prepared = [];
    for (let index = 0; index < SESSIONS + PARALLEL_PANICS; index += 1) {
      // Hazırlık aynı IP'den çok sayıda kayıt/rezervasyon ister; oran sınırı sayaçları
      // ölçüm dışı hazırlıkta temizlenir (integration testleriyle aynı yaklaşım).
      await clearRateLimits(redis);
      const fixture = await fx.setup(`lat-${index}`, 'CHECKED_IN');
      const session = await fx.sessionOf(fixture.bookingId);
      prepared.push({ fixture, sessionId: session.id as string });
    }

    await clearRateLimits(redis);
    const telemetry: number[] = [];
    const evaluation: number[] = [];
    const panic: number[] = [];
    const evaluationService = app.get(SafetyEvaluationService);

    for (const { fixture, sessionId } of prepared.slice(0, SESSIONS)) {
      const body = fx.batch(
        1,
        fx.clock(-110, 6),
        Array.from({ length: 10 }, () => ({})),
      );
      let started = performance.now();
      await fx.send(sessionId, fixture.providerToken, body).expect(200);
      telemetry.push(performance.now() - started);

      started = performance.now();
      await evaluationService.evaluate(sessionId);
      evaluation.push(performance.now() - started);

      started = performance.now();
      await fx
        .http()
        .post(`/api/v1/safety/sessions/${sessionId}/panic`)
        .set('authorization', fixture.providerToken)
        .send({})
        .expect(201);
      panic.push(performance.now() - started);
    }

    // Eşzamanlı panik: farklı oturumlarda aynı anda basılan paniklerin gecikmesi.
    const parallel = await Promise.all(
      prepared.slice(SESSIONS).map(async ({ fixture, sessionId }) => {
        const started = performance.now();
        await fx
          .http()
          .post(`/api/v1/safety/sessions/${sessionId}/panic`)
          .set('authorization', fixture.providerToken)
          .send({})
          .expect(201);
        return performance.now() - started;
      }),
    );

    const payload = {
      experiment: 'EXP-004-latency',
      environment: {
        note: 'Yerel geliştirme makinesi; Docker Postgres/Redis; tek istemci. Yük testi değildir.',
        platform: `${platform()} ${release()}`,
        cpu: cpus()[0]?.model ?? 'unknown',
        node: process.version,
        anomaly_service: 'erişilemez (127.0.0.1:9) — bozulmuş mod ölçülür',
      },
      telemetry_batch_10_samples_http: summary(telemetry),
      evaluation_service_call_ai_down: summary(evaluation),
      panic_http_sequential: summary(panic),
      panic_http_parallel_distinct_sessions: summary(parallel),
    };

    const config = await resolveConfig(OUTPUT);
    writeFileSync(
      OUTPUT,
      await format(JSON.stringify(payload, null, 2), { ...config, filepath: OUTPUT }),
      'utf8',
    );
    process.stdout.write(`EXP-004 gecikme ölçümü yazıldı: ${OUTPUT}\n`);
  } finally {
    await app.close();
    await pool.end();
    redis.disconnect();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`EXP-004 gecikme ölçümü başarısız: ${String(error)}\n`);
  process.exit(1);
});
