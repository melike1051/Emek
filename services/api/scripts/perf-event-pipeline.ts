/**
 * EXP-007 — Event pipeline lag ve throughput (Faz 14, S-10; R-43, R-63).
 *
 * Çalıştırma (yerel altyapı + Pub/Sub emulator açık olmalı):
 *   npm run infra:up:events
 *   npm run perf:event-pipeline --workspace=@emek/api
 *
 * **Yalnızca `_test` ile biten veritabanında çalışır** ve domain tablolarını sıfırlar.
 *
 * Ölçülen üç ayrı süre birbirine karıştırılmaz:
 *   1. `enqueue → published`  : outbox yayıncısının transport'a teslim süresi
 *                               (`published_at - occurred_at`, tek DB saati).
 *   2. `published → processed`: mesajın Pub/Sub'dan tüketiciye ulaşıp işlenmesi
 *                               (`processed_at - published_at`).
 *   3. `enqueue → processed`  : uçtan uca (1 + 2 + poll aralığı).
 *
 * **Etiket: local benchmark — Pub/Sub *emulator*.** Emulator gerçek Pub/Sub'ın ağ
 * gecikmesini, akış kontrolünü, teslim dağılımını ve bölge gecikmesini **temsil
 * etmez** (EXP-007 §8 limitation 4). Buradaki sayılar üretim lag'i hakkında hiçbir
 * iddia üretmez; ölçülen şey **bizim boru hattımızın** (outbox claim → publish →
 * subscriber → runner → consumer) kendi maliyetidir.
 */

import { randomUUID } from 'node:crypto';
import { cpus, platform, release } from 'node:os';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { PubSub } from '@google-cloud/pubsub';
import type { Pool } from 'pg';
import { setupPubSubTopology } from './setup-pubsub';
import { OutboxPublisher } from '../src/common/outbox/outbox.publisher';
import { createPool, createTestApp, resetDomainTables } from '../test/helpers/test-app';

const OUTPUT = resolve(__dirname, '../../../docs/research/experiments/exp-007-event-pipeline.json');

/** Ölçülen parti büyüklükleri. Outbox batch boyutu 50'dir: 50/200/500 sırasıyla 1/4/10 tur. */
const BATCH_SIZES = [50, 200, 500];
/** Tüketimin tamamlanmasını bekleme üst sınırı (ms). Aşılırsa eksik sayısı raporlanır. */
const CONSUME_TIMEOUT_MS = 120_000;
/** Tüketim yoklama aralığı (ms). Uçtan uca ölçüme bu aralık kadar tanecik hatası ekler. */
const POLL_INTERVAL_MS = 50;
/** Analytics consumer her event tipini dinler; ilerleme bunun üzerinden sayılır. */
const PROBE_CONSUMER = 'analytics-export';

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Outbox'a N event yazar ve event id'lerini döner. Tek transaction: gerçek domain
 * yazımıyla aynı yol.
 *
 * `occurred_at` **satır başına** `clock_timestamp()` ile yazılır. Sütun varsayılanı
 * `now()`'dur ve `now()` transaction **başlangıcını** verir: 500 satırlık bir partide
 * her satırın `occurred_at`'i aynı olurdu ve `published_at - occurred_at`, yayın
 * süresine ek olarak **ekleme döngüsünün tamamını** ölçerdi. O ölçüm parti boyutuyla
 * büyür ve bir boru hattı ölçeklenme etkisi gibi okunurdu — oysa ölçtüğü şey bu
 * betiğin kendi `INSERT` döngüsü olurdu (Faz 14 code review).
 */
async function enqueue(pool: Pool, count: number): Promise<string[]> {
  const client = await pool.connect();
  const ids: string[] = [];
  try {
    await client.query('BEGIN');
    for (let i = 0; i < count; i += 1) {
      const result = await client.query<{ event_id: string }>(
        `INSERT INTO outbox
           (event_type, event_version, subject_type, subject_id, payload, occurred_at)
         VALUES ('BookingCreated', 1, 'booking', $1, $2, clock_timestamp())
         RETURNING event_id`,
        [
          randomUUID(),
          JSON.stringify({
            bookingId: randomUUID(),
            serviceId: randomUUID(),
            customerId: randomUUID(),
          }),
        ],
      );
      ids.push(result.rows[0]!.event_id);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return ids;
}

/**
 * Bu partiye ait işlenmiş event sayısı.
 *
 * Sayımlar **bu partinin event id'lerine** daraltılır. Önceki sayım tüm tabloyu
 * okuyor ve tablolar partiler arasında `TRUNCATE` ediliyordu — abone hâlâ canlıyken.
 * Geç gelen bir mesaj, silinmiş `processed_events` yüzünden artık duplicate olarak
 * tanınmaz, yeniden işlenir ve sayacı kirletirdi. Yani "duplicate etki 0" iddiası,
 * betiğin kendi sildiği duruma dayanıyordu (Faz 14 code review). Artık tablolar
 * yalnızca **başlangıçta** bir kez sıfırlanır.
 */
async function countProcessed(pool: Pool, eventIds: string[]): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM processed_events
      WHERE consumer = $1 AND event_id = ANY($2::uuid[])`,
    [PROBE_CONSUMER, eventIds],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function lagSamples(
  pool: Pool,
  eventIds: string[],
): Promise<{
  enqueueToPublished: number[];
  publishedToProcessed: number[];
  enqueueToProcessed: number[];
}> {
  const rows = await pool.query<{
    publish_ms: string;
    deliver_ms: string | null;
    total_ms: string | null;
  }>(
    `SELECT EXTRACT(EPOCH FROM (o.published_at - o.occurred_at)) * 1000 AS publish_ms,
            EXTRACT(EPOCH FROM (p.processed_at - o.published_at)) * 1000 AS deliver_ms,
            EXTRACT(EPOCH FROM (p.processed_at - o.occurred_at)) * 1000 AS total_ms
       FROM outbox o
       LEFT JOIN processed_events p ON p.event_id = o.event_id AND p.consumer = $1
      WHERE o.published_at IS NOT NULL
        AND o.event_id = ANY($2::uuid[])`,
    [PROBE_CONSUMER, eventIds],
  );

  const enqueueToPublished: number[] = [];
  const publishedToProcessed: number[] = [];
  const enqueueToProcessed: number[] = [];
  for (const row of rows.rows) {
    enqueueToPublished.push(Number(row.publish_ms));
    if (row.deliver_ms !== null) publishedToProcessed.push(Number(row.deliver_ms));
    if (row.total_ms !== null) enqueueToProcessed.push(Number(row.total_ms));
  }
  return { enqueueToPublished, publishedToProcessed, enqueueToProcessed };
}

async function main(): Promise<void> {
  const testUrl = process.env.DATABASE_URL_TEST;
  if (testUrl === undefined || !new URL(testUrl).pathname.endsWith('_test')) {
    throw new Error("DATABASE_URL_TEST tanımlı ve '_test' ile biten bir veritabanı olmalı");
  }
  process.env.DATABASE_URL = testUrl;
  process.env.NODE_ENV = 'test';
  // Gerçek Pub/Sub istemcisi (emulator'a bağlı) kullanılır: LoggingEventTransport ile
  // ölçülen şey boru hattı değil, bir log satırı olurdu.
  process.env.PUBSUB_EMULATOR_HOST ??= '127.0.0.1:8085';
  process.env.EVENT_TRANSPORT_TYPE = 'pubsub';
  process.env.GCP_PROJECT_ID ??= 'emek-local';
  // Analitik/mutabakat worker'ları kapalı: ölçülen boru hattı event teslimidir,
  // zamanlanmış işlerin aynı havuzu tüketmesi ölçümü kirletirdi.
  process.env.ANALYTICS_EXPORT_ENABLED = 'false';
  process.env.RECONCILIATION_ENABLED = 'false';
  process.env.SAFETY_MONITOR_ENABLED = 'false';

  const projectId = process.env.GCP_PROJECT_ID;
  await setupPubSubTopology(new PubSub({ projectId }));

  const pool: Pool = createPool();
  let app: INestApplication | undefined;
  const results: Record<string, unknown> = {};

  try {
    await resetDomainTables(pool);
    app = await createTestApp();
    const publisher = app.get(OutboxPublisher);

    for (const batchSize of BATCH_SIZES) {
      // Önceki partinin mesajlarının teslim edilmesi beklenir. Tablolar burada
      // **sıfırlanmaz** (bkz. `countProcessed`): abone canlıyken dedup tablosunu
      // silmek, ölçülmek istenen garantiyi ölçümün kendisi bozardı.
      await sleep(500);

      const eventIds = await enqueue(pool, batchSize);

      const publishStart = Date.now();
      const published = await publisher.drain();
      const publishElapsed = Date.now() - publishStart;

      const consumeStart = Date.now();
      let processed = 0;
      while (Date.now() - consumeStart < CONSUME_TIMEOUT_MS) {
        processed = await countProcessed(pool, eventIds);
        if (processed >= batchSize) break;
        await sleep(POLL_INTERVAL_MS);
      }
      const consumeElapsed = Date.now() - consumeStart;

      const lags = await lagSamples(pool, eventIds);

      const analytics = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM analytics_events WHERE event_id = ANY($1::uuid[])`,
        [eventIds],
      );
      const dlq = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM dead_letter_events WHERE event_id = ANY($1::uuid[])`,
        [eventIds],
      );
      const outboxFailed = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM outbox
          WHERE status = 'FAILED' AND event_id = ANY($1::uuid[])`,
        [eventIds],
      );

      results[`batch_${batchSize}`] = {
        enqueued: batchSize,
        published,
        processed,
        completed: processed >= batchSize,
        publish_wall_ms: publishElapsed,
        // `drain()` bu partinin **tümünü** işler; havuzda başka parti yoktur (her
        // parti yayınlanıp tüketildikten sonra sıradakine geçilir).
        publish_throughput_eps: Math.round((published / Math.max(publishElapsed, 1)) * 1000),
        // Tüketim penceresi yayınla **örtüşür** (drain biterken ilk mesajlar çoktan
        // işlenmiştir); bu yüzden bu bir alt sınır değil, gözlenen bitiş süresidir.
        consume_wall_ms: consumeElapsed,
        lag_enqueue_to_published: summary(lags.enqueueToPublished),
        lag_published_to_processed: summary(lags.publishedToProcessed),
        lag_enqueue_to_processed: summary(lags.enqueueToProcessed),
        analytics_rows: Number(analytics.rows[0]?.count ?? 0),
        // Consumer idempotenttir: teslim tekrarlansa bile satır sayısı event
        // sayısını aşmamalıdır (at-least-once teslim, exactly-once **etki**).
        duplicate_effect: Number(analytics.rows[0]?.count ?? 0) - processed,
        dead_letter_rows: Number(dlq.rows[0]?.count ?? 0),
        outbox_failed_rows: Number(outboxFailed.rows[0]?.count ?? 0),
      };

      process.stdout.write(
        `batch=${batchSize} published=${published} processed=${processed} ` +
          `publish=${publishElapsed}ms consume=${consumeElapsed}ms\n`,
      );
    }

    const output = {
      experiment: 'EXP-007-event-pipeline',
      label: 'local benchmark — Pub/Sub emulator',
      generated_at: new Date().toISOString(),
      environment: {
        platform: `${platform()} ${release()}`,
        cpus: cpus().length,
        node: process.version,
        transport: 'PubSubEventTransport → gcloud pubsub emulator (docker)',
        note:
          'Emulator gerçek Pub/Sub lag dağılımını temsil etmez (EXP-007 §8/4). ' +
          'Uygulama, veritabanı, emulator ve istemci aynı makinede.',
      },
      parameters: {
        outbox_batch_size: 50,
        poll_interval_ms: POLL_INTERVAL_MS,
        consume_timeout_ms: CONSUME_TIMEOUT_MS,
        probe_consumer: PROBE_CONSUMER,
      },
      results,
    };
    writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
    process.stdout.write(`Yazıldı: ${OUTPUT}\n`);
  } finally {
    await app?.close();
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
