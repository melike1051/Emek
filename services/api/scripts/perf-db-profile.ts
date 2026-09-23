/**
 * EXP-007 — Veritabanı sorgu profili (Faz 14, kapsam §4).
 *
 * Çalıştırma (yerel altyapı açık olmalı: `npm run infra:up`):
 *   npm run perf:db --workspace=@emek/api
 *
 * **Yalnızca `_test` ile biten veritabanında çalışır** ve domain tablolarını sıfırlar.
 *
 * Neden ölçekli sentetik veri: boş bir tabloda planlayıcı her zaman sequential scan
 * seçer ve `EXPLAIN` çıktısı hiçbir şey öğretmez. Bu yüzden önce deterministik
 * (sabit tohum, rastgelelik yok) bir veri kümesi üretilir, `ANALYZE` çalıştırılır,
 * sonra **gerçek** sorgular profillenir.
 *
 * Kural (CLAUDE.md / Faz 14): **gerçek darboğaz kanıtlanmadan index eklenmez.**
 * Bu script kanıt üretir; index kararı ölçüme bakılarak ayrıca verilir.
 *
 * Etiket: **local benchmark** — Postgres container'ı Apple silicon üzerinde
 * emülasyonlu x86_64'tür; mutlak süreler taşınabilir değildir, plan şekli ve
 * göreli maliyet taşınabilirdir.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { CANDIDATE_SQL } from '../src/matching/matching.repository';

const OUTPUT = resolve(__dirname, '../../../docs/research/experiments/exp-007-db-profile.json');

/** Ölçek. Üretim hacmi iddiası değildir; planlayıcıyı gerçekçi bir noktaya taşır. */
const PROVIDERS = 2000;
const CUSTOMERS = 2000;
const BOOKINGS_PER_PROVIDER = 25;

interface Profile {
  name: string;
  purpose: string;
  planning_ms: number;
  execution_ms: number;
  execution_min_ms: number;
  execution_max_ms: number;
  repeats: number;
  actual_rows: number;
  shared_read: number;
  scan_types: string[];
  seq_scan_on: string[];
  plan: unknown;
}

/** Plan ağacında düğüm türlerini ve sequential scan yapılan tabloları toplar. */
function walk(node: Record<string, unknown>, scans: Set<string>, seq: Set<string>): void {
  const type = node['Node Type'];
  if (typeof type === 'string') {
    scans.add(type);
    if (type === 'Seq Scan') {
      const rel = node['Relation Name'];
      if (typeof rel === 'string') {
        seq.add(rel);
      }
    }
  }
  const children = node['Plans'];
  if (Array.isArray(children)) {
    for (const child of children) {
      walk(child as Record<string, unknown>, scans, seq);
    }
  }
}

/** Tek ölçüm noktası kaç kez tekrarlanır (medyan raporlanır). */
const EXPLAIN_REPEATS = 5;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  return Math.round(value * 100) / 100;
}

async function explain(
  pool: Pool,
  name: string,
  purpose: string,
  sql: string,
  params: unknown[],
): Promise<Profile> {
  // Önce ısıtma koşusu: ilk çağrının plan önbelleği/disk okuması ölçümü kirletmesin.
  await pool.query(sql, params);

  // Tek ölçüm yetmez (Faz 14 performance review, M-4): emülasyonlu ve istemciyle
  // aynı CPU'yu paylaşan bir container'da tek `EXPLAIN ANALYZE`, gürültüyü sonuç
  // diye raporlar. Medyan alınır; dağılım da çıktıya yazılır ki okuyan ne kadar
  // oynadığını görsün.
  const planningSamples: number[] = [];
  const executionSamples: number[] = [];
  let root!: Record<string, unknown>;

  for (let repeat = 0; repeat < EXPLAIN_REPEATS; repeat += 1) {
    const result = await pool.query<{ 'QUERY PLAN': unknown[] }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
      params,
    );
    root = (result.rows[0]!['QUERY PLAN'] as Record<string, unknown>[])[0]!;
    planningSamples.push(root['Planning Time'] as number);
    executionSamples.push(root['Execution Time'] as number);
  }

  const plan = root['Plan'] as Record<string, unknown>;

  // **Sıfır satır koruması.** §11.3'te bir kez ısırdı: profil, hiç satır döndürmeyen
  // bir sorguyu "hızlı" diye raporlamıştı. O zaman yalnızca belgeye yazılmıştı;
  // review (H-3) kodda karşılığı olmadığını gösterdi. Artık sessizce geçmiyor.
  const actualRows = (plan['Actual Rows'] as number | undefined) ?? 0;
  if (actualRows === 0) {
    throw new Error(
      `${name}: sorgu 0 satır döndürdü — boş bir sorgunun süresi ölçüm değildir ` +
        '(fikstür kurulmadı ya da parametreler eşleşmiyor).',
    );
  }

  const scans = new Set<string>();
  const seq = new Set<string>();
  walk(plan, scans, seq);

  return {
    name,
    purpose,
    planning_ms: median(planningSamples),
    execution_ms: median(executionSamples),
    execution_min_ms: Math.round(Math.min(...executionSamples) * 100) / 100,
    execution_max_ms: Math.round(Math.max(...executionSamples) * 100) / 100,
    repeats: EXPLAIN_REPEATS,
    actual_rows: actualRows,
    shared_read: (plan['Shared Read Blocks'] as number) ?? 0,
    scan_types: [...scans].sort(),
    seq_scan_on: [...seq].sort(),
    plan,
  };
}

async function seed(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE booking_status_history, bookings, availability, provider_service_areas,
                   provider_services, addresses, identity_records, provider_profiles,
                   customer_profiles, user_roles, auth_subjects, users
    RESTART IDENTITY CASCADE;
  `);

  // Deterministik kimlikler: index'ten türetilmiş UUID'ler, rastgelelik yok.
  await pool.query(
    `INSERT INTO users (id, phone, status)
     SELECT ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
            '+9055' || lpad(i::text, 8, '0'),
            'ACTIVE'
       FROM generate_series(1, $1) AS i`,
    [PROVIDERS + CUSTOMERS],
  );

  await pool.query(
    `INSERT INTO provider_profiles (user_id, display_name, state, max_daily_bookings)
     SELECT ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
            'Sağlayıcı ' || i, 'APPROVED', 8
       FROM generate_series(1, $1) AS i`,
    [PROVIDERS],
  );

  await pool.query(
    `INSERT INTO customer_profiles (user_id, display_name)
     SELECT ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
            'Müşteri ' || i
       FROM generate_series($1 + 1, $1 + $2) AS i`,
    [PROVIDERS, CUSTOMERS],
  );

  // Kimlik kayıtları: aday havuzu sorgusu doğrulanmamış sağlayıcıyı **eler**. Bunlar
  // seed edilmezse sorgu sıfır satır döner ve profil hiçbir şey ölçmez (ilk koşuda
  // tam olarak bu oldu). `identity_hash` burada sentetik bir değerdir; gerçek üretim
  // yolu adapter sınırının içindeki KMS HMAC'idir (ADR-0004).
  await pool.query(
    `INSERT INTO identity_records (user_id, verification_provider, provider_subject_id,
                                   identity_hash, hash_key_version, verification_status,
                                   verified_at)
     SELECT ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
            'mock', 'perf-subject-' || i,
            encode(sha256(('perf-identity-' || i)::bytea), 'hex'),
            'perf-v1', 'VERIFIED', now()
       FROM generate_series(1, $1) AS i`,
    [PROVIDERS],
  );

  // Adresler İstanbul çevresinde deterministik bir ızgaraya yerleşir.
  await pool.query(
    // `location` üretilmiş (generated) sütundur: latitude/longitude'dan türetilir.
    `INSERT INTO addresses (user_id, city, district, line, latitude, longitude)
     SELECT ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
            'İstanbul', 'Kadıköy', 'Profil Sokak ' || i,
            40.95 + ((i % 50)::float / 1000),
            29.00 + ((i / 50)::int % 50)::float / 1000
       FROM generate_series($1 + 1, $1 + $2) AS i`,
    [PROVIDERS, CUSTOMERS],
  );

  await pool.query(
    `INSERT INTO provider_services (provider_id, service_id, active)
     SELECT ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, s.id, true
       FROM generate_series(1, $1) AS i
       CROSS JOIN LATERAL (SELECT id FROM services ORDER BY id LIMIT 2) AS s`,
    [PROVIDERS],
  );

  // Hizmet bölgeleri: her sağlayıcı adres ızgarasını kapsayan bir daire beyan eder.
  await pool.query(
    `INSERT INTO provider_service_areas (provider_id, name, area, active, radius_meters)
     SELECT ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
            'Bölge ' || i,
            ST_Buffer(
              ST_SetSRID(ST_MakePoint(29.00 + ((i % 50)::float / 1000),
                                      40.95 + ((i % 50)::float / 1000)), 4326)::geography,
              4000)::geography,
            true, 4000
       FROM generate_series(1, $1) AS i`,
    [PROVIDERS],
  );

  // Müsaitlik: her sağlayıcı için 7 gün, günde tek pencere (çakışma yok — EXCLUDE).
  await pool.query(
    `INSERT INTO availability (provider_id, starts_at, ends_at)
     SELECT ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
            date_trunc('day', now()) + (d || ' days')::interval + interval '7 hours',
            date_trunc('day', now()) + (d || ' days')::interval + interval '21 hours'
       FROM generate_series(1, $1) AS i, generate_series(1, 7) AS d`,
    [PROVIDERS],
  );

  // Rezervasyonlar: sağlayıcı başına çakışmayan yarım saatlik dilimler.
  await pool.query(
    `INSERT INTO bookings (customer_id, provider_id, service_id, address_id,
                           scheduled_start, scheduled_end, price_minor, status)
     SELECT c.user_id, p.provider_id, p.service_id, c.address_id,
            date_trunc('day', now()) + ((k % 7) + 1 || ' days')::interval
              + interval '7 hours' + ((k % 20) * 30 || ' minutes')::interval,
            date_trunc('day', now()) + ((k % 7) + 1 || ' days')::interval
              + interval '7 hours' + ((k % 20) * 30 + 30 || ' minutes')::interval,
            15000, 'REQUESTED'
       FROM generate_series(1, $1) AS i
       CROSS JOIN generate_series(0, $3 - 1) AS k
       CROSS JOIN LATERAL (
         SELECT ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid AS provider_id,
                (SELECT id FROM services ORDER BY id LIMIT 1) AS service_id
       ) AS p
       CROSS JOIN LATERAL (
         SELECT a.user_id, a.id AS address_id
           FROM addresses a
          WHERE a.user_id = ('00000000-0000-4000-8000-'
                || lpad(($1 + 1 + ((i + k) % $2))::text, 12, '0'))::uuid
          LIMIT 1
       ) AS c
     ON CONFLICT DO NOTHING`,
    [PROVIDERS, CUSTOMERS, BOOKINGS_PER_PROVIDER],
  );

  await pool.query('ANALYZE');
}

async function main(): Promise<void> {
  const testUrl = process.env.DATABASE_URL_TEST;
  if (testUrl === undefined || !new URL(testUrl).pathname.endsWith('_test')) {
    throw new Error("DATABASE_URL_TEST tanımlı ve '_test' ile biten bir veritabanı olmalı");
  }

  const pool = new Pool({ connectionString: testUrl, max: 4 });
  try {
    process.stdout.write('Sentetik veri üretiliyor...\n');
    await seed(pool);

    const counts = await pool.query<{ table_name: string; rows: string }>(`
      SELECT relname AS table_name, n_live_tup::text AS rows
        FROM pg_stat_user_tables
       WHERE relname IN ('users','provider_profiles','customer_profiles','addresses',
                         'availability','bookings','provider_service_areas','provider_services')
       ORDER BY relname
    `);
    process.stdout.write('Profil çalıştırılıyor...\n');

    const provider = '00000000-0000-4000-8000-000000000001';
    const address = (
      await pool.query<{ id: string }>(`SELECT id FROM addresses ORDER BY created_at LIMIT 1`)
    ).rows[0]!.id;
    const service = (
      await pool.query<{ id: string }>(`SELECT id FROM services ORDER BY id LIMIT 1`)
    ).rows[0]!.id;

    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    dayStart.setUTCDate(dayStart.getUTCDate() + 1);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const slotStart = new Date(dayStart.getTime() + 9 * 60 * 60 * 1000);
    const slotEnd = new Date(slotStart.getTime() + 60 * 60 * 1000);

    const profiles: Profile[] = [];

    profiles.push(
      await explain(
        pool,
        'availability_window_lock',
        'Booking create: müsaitlik penceresini bulur ve kilitler (isAvailableLocked #1)',
        `SELECT id FROM availability
          WHERE provider_id = $1 AND slot @> tstzrange($2, $3, '[)')
          LIMIT 1`,
        [provider, slotStart, slotEnd],
      ),
    );

    profiles.push(
      await explain(
        pool,
        'booking_conflict_check',
        'Booking create: istisna veya aktif rezervasyon çakışması (isAvailableLocked #2)',
        `SELECT (
           EXISTS (SELECT 1 FROM availability_exceptions
                    WHERE provider_id = $1 AND slot && tstzrange($2, $3, '[)'))
           OR EXISTS (SELECT 1 FROM bookings
                       WHERE provider_id = $1 AND status <> 'CANCELLED'
                         AND slot && tstzrange($2, $3, '[)'))
         ) AS blocked`,
        [provider, slotStart, slotEnd],
      ),
    );

    profiles.push(
      await explain(
        pool,
        'candidate_retrieval',
        'Matching: aday havuzu (PostGIS kapsama + mesafe + müsaitlik farkı)',
        CANDIDATE_SQL,
        [address, service, slotStart, slotEnd, 60, dayStart, dayEnd, 20000, 50],
      ),
    );

    profiles.push(
      await explain(
        pool,
        'provider_capacity',
        'Matching: yazma transaction’ında taze günlük kapasite (readCapacity)',
        `SELECT pp.max_daily_bookings,
                (SELECT count(*) FROM bookings b
                  WHERE b.provider_id = pp.user_id
                    AND b.status <> 'CANCELLED'
                    AND b.scheduled_start >= $2::timestamptz
                    AND b.scheduled_start < $3::timestamptz)::text AS daily_count
           FROM provider_profiles pp
          WHERE pp.user_id = $1`,
        [provider, dayStart, dayEnd],
      ),
    );

    profiles.push(
      await explain(
        pool,
        'customer_booking_list',
        'Müşterinin rezervasyon listesi (sık okunan uç)',
        `SELECT id, provider_id, scheduled_start, status FROM bookings
          WHERE customer_id = $1 ORDER BY scheduled_start DESC LIMIT 20`,
        [
          (
            await pool.query<{ user_id: string }>(
              `SELECT customer_id AS user_id FROM bookings LIMIT 1`,
            )
          ).rows[0]!.user_id,
        ],
      ),
    );

    profiles.push(
      await explain(
        pool,
        'outbox_dispatchable',
        'Outbox: yayınlanmayı bekleyen event taraması (her turda çalışır)',
        `SELECT event_id FROM outbox
          WHERE status <> 'PUBLISHED' AND next_attempt_at <= now()
          ORDER BY occurred_at LIMIT 100`,
        [],
      ),
    );

    // ---- Aday havuzu ölçek eğrisi (R-16) ---------------------------------------
    //
    // Aday havuzu sorgusu, uygun **her** sağlayıcı için merkez/mesafe/müsaitlik farkı
    // hesaplar ve elemeyi bilinçli olarak `LIMIT`'ten **önce** yapar (sorgudaki
    // gerekçeli yorum). Dolayısıyla maliyet, toplam sağlayıcı sayısıyla değil, adresi
    // **kapsayan** sağlayıcı yoğunluğuyla büyür. Ölçülen budur.
    // Eğri noktaları da satır sayısını ve dağılımı **taşır** (Faz 14 review, H-3):
    // önceki sürüm yalnızca `execution_ms` saklıyordu, yani "diz" sonucunu doğrulamak
    // için gereken kanıt (sorgu gerçekten satır döndürdü mü, ne kadar oynadı) çıktıda
    // yoktu. `explain` zaten sıfır satırda hata veriyor; burada sayı kayda geçiyor.
    const curve: {
      eligible_providers: number;
      execution_ms: number;
      execution_min_ms: number;
      execution_max_ms: number;
      actual_rows: number;
      repeats: number;
    }[] = [];
    for (const active of [100, 250, 500, 1000, 2000]) {
      await pool.query(`UPDATE provider_service_areas SET active = (provider_id <= $1::uuid)`, [
        '00000000-0000-4000-8000-' + String(active).padStart(12, '0'),
      ]);
      await pool.query('ANALYZE provider_service_areas');
      const measured = await explain(
        pool,
        `candidate_retrieval_${active}`,
        'Aday havuzu ölçek eğrisi',
        CANDIDATE_SQL,
        [address, service, slotStart, slotEnd, 60, dayStart, dayEnd, 20000, 50],
      );
      const eligible = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM provider_service_areas psa,
                (SELECT location FROM addresses WHERE id = $1) t
          WHERE psa.active AND ST_Intersects(psa.area, t.location)`,
        [address],
      );
      curve.push({
        eligible_providers: Number(eligible.rows[0]!.count),
        execution_ms: measured.execution_ms,
        execution_min_ms: measured.execution_min_ms,
        execution_max_ms: measured.execution_max_ms,
        actual_rows: measured.actual_rows,
        repeats: measured.repeats,
      });
      process.stdout.write(
        `  eligible=${eligible.rows[0]!.count} exec=${measured.execution_ms}ms\n`,
      );
    }
    await pool.query('UPDATE provider_service_areas SET active = true');
    await pool.query('ANALYZE provider_service_areas');

    const output = {
      experiment: 'EXP-007',
      label: 'local benchmark',
      generated_at: new Date().toISOString(),
      note: 'Postgres x86_64 emülasyonlu; mutlak süre taşınabilir değil, plan şekli taşınabilir.',
      dataset: Object.fromEntries(counts.rows.map((r) => [r.table_name, Number(r.rows)])),
      candidate_scaling_curve: curve,
      profiles,
    };
    writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);

    for (const p of profiles) {
      process.stdout.write(
        `${p.name.padEnd(26)} exec=${String(p.execution_ms).padStart(9)}ms  plan=${String(
          p.planning_ms,
        ).padStart(6)}ms  seq=${p.seq_scan_on.join(',') || '-'}\n`,
      );
    }
    process.stdout.write(`Yazıldı: ${OUTPUT}\n`);
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
