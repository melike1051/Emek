import { randomBytes, randomInt } from 'node:crypto';
import { Redis } from 'ioredis';
import pg from 'pg';

/**
 * E2E test verisi. Kullanıcı akışının parçası olmayan ön koşullar (başka bir aktörün onayı,
 * kimlik doğrulama callback'i, beceri doğrulama) API + doğrudan SQL ile kurulur — tıpkı
 * `services/api/test/matching.integration.spec.ts` gibi. Sınanan akış her zaman arayüzden geçer.
 *
 * Yalnız yerel geliştirme veritabanına yazılır (`E2E_DATABASE_URL`); her kayıt benzersiz bir
 * `e2e-` önekli kimlik ve rastgele bir konum taşır, böylece paylaşılan yerel veriyle çakışmaz.
 */
export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000/api/v1';
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://emek:emek_local_dev@localhost:5432/emek';
const REDIS_URL = process.env.E2E_REDIS_URL ?? 'redis://localhost:6379';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Seed doğrudan SQL ile doğrulanmış sağlayıcı yazar ve oran sınırı sayaçlarını siler: yanlışlıkla
 * staging/production'a yönelmiş bir ortam değişkeni sahte onaylı hesap üretir ve gerçek oran
 * sınırını sıfırlardı. Bu yüzden üç hedefin de yerel olması şarttır; istisna yoktur.
 */
export function assertLocalTargets(): void {
  for (const [name, value] of [
    ['E2E_API_URL', API_URL],
    ['E2E_DATABASE_URL', DATABASE_URL],
    ['E2E_REDIS_URL', REDIS_URL],
  ] as const) {
    const host = new URL(value).hostname;
    if (!LOCAL_HOSTS.has(host)) {
      throw new Error(`${name} yerel değil (${host}); E2E yalnız yerel altyapıya karşı koşar.`);
    }
  }
}
assertLocalTargets();

let pool: pg.Pool | null = null;
function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  return pool;
}
export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = null;
}

/**
 * Oran sınırı sayaçlarını temizler (`services/api/test/helpers/test-app.ts` ile aynı gerekçe):
 * E2E her aktör için aynı IP'den `POST /auth/session` çağırır ve gerçek, fail-closed sınır
 * ardışık koşuları 429 ile düşürür. Korumayı zayıflatmaz — yalnız yerel sayaçları sıfırlar;
 * sınırın kendisi API entegrasyon testlerinde doğrulanır.
 */
export async function clearRateLimits(): Promise<void> {
  const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 2,
    lazyConnect: true,
  });
  try {
    await redis.connect();
    // KEYS Redis'i bloklar; SCAN artımlıdır.
    for await (const keys of redis.scanStream({ match: 'ratelimit:*', count: 500 })) {
      if ((keys as string[]).length > 0) await redis.del(...(keys as string[]));
    }
  } finally {
    redis.disconnect();
  }
}

export interface Actor {
  subject: string;
  /** Yerel biçim — giriş formuna yazılır (ör. `0532 111 22 33`). */
  phoneLocal: string;
  userId: string;
}

export function uniqueSubject(prefix: string): string {
  return `e2e-${prefix}-${randomBytes(5).toString('hex')}`;
}

export function randomPhone(): { e164: string; local: string } {
  const rest = String(randomInt(0, 100_000_000)).padStart(8, '0');
  return { e164: `+9053${rest}`, local: `053${rest}` };
}

export function bearerFor(actor: Pick<Actor, 'subject'>): string {
  return `Bearer mock:${actor.subject}`;
}

async function api<T>(
  path: string,
  token: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'POST',
    headers: {
      authorization: token,
      'content-type': 'application/json',
      'idempotency-key': randomBytes(16).toString('hex'),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? 'POST'} ${path} → ${response.status}: ${text}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Kullanıcıyı backend'de açar (ilk `POST /auth/session` iletişim bilgisi ister). */
export async function registerActor(prefix: string): Promise<Actor> {
  const subject = uniqueSubject(prefix);
  const phone = randomPhone();
  const session = await api<{ userId: string }>(
    '/auth/session',
    `Bearer mock:${subject}:phone=${phone.e164}`,
  );
  return { subject, phoneLocal: phone.local, userId: session.userId };
}

/** Yalnız operatör rolleri: arayüzde rol verme akışı yoktur (operasyonel karar). */
export async function grantRole(actor: Actor, role: 'ADMIN' | 'SUPPORT'): Promise<void> {
  await db().query(`INSERT INTO user_roles (user_id, role) VALUES ($1, $2)`, [actor.userId, role]);
}

async function idBySlug(table: 'services' | 'skills', slug: string): Promise<string> {
  const result = await db().query<{ id: string }>(`SELECT id FROM ${table} WHERE slug = $1`, [
    slug,
  ]);
  const id = result.rows[0]?.id;
  if (!id) {
    throw new Error(`${table}.${slug} yok — önce: npm run seed:catalog --workspace=@emek/api`);
  }
  return id;
}

export const SERVICE_SLUG = 'detayli-temizlik';
const SKILL_SLUG = 'derin-temizlik';

/** Türkiye içinde rastgele bir nokta: paylaşılan yerel veritabanındaki sağlayıcılardan uzak. */
export function randomLocation(): { latitude: number; longitude: number } {
  return {
    latitude: Number((37.5 + Math.random() * 2.5).toFixed(5)),
    longitude: Number((30 + Math.random() * 10).toFixed(5)),
  };
}

/** Yarın, UTC saatine göre. */
export function tomorrowUtc(hour: number): Date {
  const moment = new Date();
  moment.setUTCDate(moment.getUTCDate() + 1);
  moment.setUTCHours(hour, 0, 0, 0);
  return moment;
}

export interface ProviderSeed extends Actor {
  displayName: string;
}

/**
 * Sağlayıcı profili. `approved` ise eşleşmeye hazırdır: onaylı, kimliği doğrulanmış, beceri
 * doğrulanmış, verilen konumda hizmet bölgesi ve yarın 06:00–20:00 UTC müsaitliği var.
 */
export async function seedProvider(options: {
  state: 'APPROVED' | 'PENDING_REVIEW';
  location?: { latitude: number; longitude: number };
}): Promise<ProviderSeed> {
  const actor = await registerActor('provider');
  const token = bearerFor(actor);
  const displayName = `E2E Sağlayıcı ${actor.subject.slice(-6)}`;
  await api('/providers/profile', token, { body: { displayName } });

  if (options.state === 'APPROVED') {
    const location = options.location ?? randomLocation();
    await api('/providers/me/services', token, {
      body: { serviceId: await idBySlug('services', SERVICE_SLUG) },
    });
    const skillId = await idBySlug('skills', SKILL_SLUG);
    await api('/providers/me/skills', token, { body: { skillId, level: 'EXPERT' } });
    await api('/providers/me/service-areas', token, {
      body: { name: 'E2E bölge', ...location, radiusMeters: 5_000 },
    });
    await api('/providers/me/availability', token, {
      body: { startsAt: tomorrowUtc(6).toISOString(), endsAt: tomorrowUtc(20).toISOString() },
    });
    await db().query(
      `UPDATE provider_skills SET verified = TRUE WHERE provider_id = $1 AND skill_id = $2`,
      [actor.userId, skillId],
    );
    await db().query(
      `INSERT INTO identity_records
         (user_id, verification_provider, provider_subject_id, identity_hash,
          hash_key_version, verification_level, verification_status, assurance_level, verified_at)
       VALUES ($1, 'mock', $2, $3, 'v1', 'PROVIDER_VERIFIED', 'VERIFIED', 'HIGH', now())`,
      [actor.userId, actor.subject, randomBytes(32).toString('hex')],
    );
  }
  await db().query(`UPDATE provider_profiles SET state = $2::provider_state WHERE user_id = $1`, [
    actor.userId,
    options.state,
  ]);
  return { ...actor, displayName };
}

export async function providerState(userId: string): Promise<string> {
  const result = await db().query<{ state: string }>(
    `SELECT state FROM provider_profiles WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0]?.state ?? 'NONE';
}

export async function bookingStatus(bookingId: string): Promise<string> {
  const result = await db().query<{ status: string }>(`SELECT status FROM bookings WHERE id = $1`, [
    bookingId,
  ]);
  return result.rows[0]?.status ?? 'NONE';
}

/**
 * API ile sağlayıcı onayı bekleyen (`PROVIDER_PENDING`) bir randevu: müşteri + adres + talep +
 * eşleştirme. Sağlayıcı akışının arayüz sınaması (web/mobil) buradan başlar.
 */
export async function seedPendingBooking(): Promise<{
  bookingId: string;
  customer: Actor;
  provider: ProviderSeed;
  location: { latitude: number; longitude: number };
}> {
  const location = randomLocation();
  const provider = await seedProvider({ state: 'APPROVED', location });
  const customer = await registerActor('customer');
  const token = bearerFor(customer);
  await api('/customers/profile', token, { body: { displayName: 'E2E Müşteri' } });
  const address = await api<{ id: string }>('/addresses', token, {
    body: { city: 'Ankara', district: 'Çankaya', line: 'E2E Sokak No 1', ...location },
  });
  const request = await api<{ id: string }>('/booking-requests', token, {
    body: {
      serviceId: await idBySlug('services', SERVICE_SLUG),
      addressId: address.id,
      preferredStart: tomorrowUtc(8).toISOString(),
      preferredEnd: tomorrowUtc(18).toISOString(),
      durationMinutes: 180,
    },
  });
  const match = await api<{ bookingId: string | null }>(
    `/booking-requests/${request.id}/match`,
    token,
  );
  if (!match.bookingId) throw new Error('E2E eşleşme rezervasyon üretmedi');
  return { bookingId: match.bookingId, customer, provider, location };
}

/**
 * API ile planlanmış (`SCHEDULED`, ödeme `HELD`) bir randevu. Müşteri akışının arayüz sınaması
 * `web.booking.spec.ts`'tedir; burada yalnız operatör ekranlarına veri hazırlanır.
 */
export async function seedScheduledBooking(): Promise<{
  bookingId: string;
  customer: Actor;
  provider: ProviderSeed;
}> {
  const seeded = await seedPendingBooking();
  await api(`/bookings/${seeded.bookingId}/confirm`, bearerFor(seeded.provider));
  await api(`/bookings/${seeded.bookingId}/payment`, bearerFor(seeded.customer));
  return seeded;
}

export async function paymentRefundedMinor(bookingId: string): Promise<string> {
  const result = await db().query<{ refunded_minor: string }>(
    `SELECT refunded_minor::text FROM payments WHERE booking_id = $1`,
    [bookingId],
  );
  return result.rows[0]?.refunded_minor ?? 'NONE';
}

export async function safetyState(
  bookingId: string,
): Promise<{ riskLevel: string; panicCount: number } | null> {
  const result = await db().query<{ risk_level: string; panic_count: number }>(
    `SELECT risk_level, panic_count FROM safety_sessions WHERE booking_id = $1`,
    [bookingId],
  );
  const row = result.rows[0];
  return row ? { riskLevel: row.risk_level, panicCount: row.panic_count } : null;
}

/**
 * Sağlayıcı cihazının konum telemetrisi. Web'de telemetri istemcisi yoktur (mobil uygulamanın
 * işidir, `apps/mobile/integration_test/telemetry_flow_test.dart`); tam zincirde aynı uç
 * doğrudan çağrılır. Sunucu kabul/red kararını örnek başına döner.
 */
export async function sendTelemetry(
  provider: Pick<Actor, 'subject'>,
  bookingId: string,
  location: { latitude: number; longitude: number },
): Promise<{ sessionStatus: string; results: { status: string; reason: string | null }[] }> {
  const token = bearerFor(provider);
  const session = await api<{ sessionId: string; status: string; lastSequence: number }>(
    `/bookings/${bookingId}/safety-session`,
    token,
    { method: 'GET' },
  );
  const ingest = await api<{ results: { status: string; reason: string | null }[] }>(
    `/safety/sessions/${session.sessionId}/telemetry`,
    token,
    {
      body: {
        samples: [
          {
            sequence: session.lastSequence + 1,
            capturedAt: new Date().toISOString(),
            ...location,
            accuracyMeters: 12,
          },
        ],
      },
    },
  );
  return { sessionStatus: session.status, results: ingest.results };
}

/** Rezervasyonun durum geçmişi, sırayla (`booking_status_history`). */
export async function statusHistory(bookingId: string): Promise<string[]> {
  const result = await db().query<{ to_status: string }>(
    `SELECT to_status FROM booking_status_history WHERE booking_id = $1 ORDER BY id`,
    [bookingId],
  );
  return result.rows.map((row) => row.to_status);
}

/**
 * Rezervasyonun ve ödemesinin outbox event tipleri (alfabetik: aynı transaction'daki eventlerin
 * zamanı eşittir). Ödeme eventlerinin konusu ödemedir, rezervasyon değil.
 */
export async function outboxEventTypes(bookingId: string): Promise<string[]> {
  const result = await db().query<{ event_type: string }>(
    `SELECT event_type FROM outbox
      WHERE subject_id = $1
         OR subject_id IN (SELECT id FROM payments WHERE booking_id = $1)
      ORDER BY event_type`,
    [bookingId],
  );
  return result.rows.map((row) => row.event_type);
}

/** Rezervasyonu üreten eşleştirme kararının kaydı (ADR-0012 §1: sürümler zorunlu). */
export async function matchingRunFor(bookingId: string): Promise<{
  algorithmVersion: string;
  strategy: string;
  degradedReason: string | null;
} | null> {
  const result = await db().query<{
    algorithm_version: string;
    strategy: string;
    degraded_reason: string | null;
  }>(
    `SELECT r.algorithm_version, r.strategy::text, r.degraded_reason::text
       FROM matching_runs r JOIN bookings b ON b.request_id = r.request_id
      WHERE b.id = $1 ORDER BY r.created_at DESC LIMIT 1`,
    [bookingId],
  );
  const row = result.rows[0];
  return row
    ? {
        algorithmVersion: row.algorithm_version,
        strategy: row.strategy,
        degradedReason: row.degraded_reason,
      }
    : null;
}

export async function paymentStatus(bookingId: string): Promise<string> {
  const result = await db().query<{ status: string }>(
    `SELECT status FROM payments WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [bookingId],
  );
  return result.rows[0]?.status ?? 'NONE';
}

export async function reviewsFor(
  bookingId: string,
): Promise<{ rating: number; authorId: string }[]> {
  const result = await db().query<{ rating: number; author_user_id: string }>(
    `SELECT rating, author_user_id FROM reviews WHERE booking_id = $1`,
    [bookingId],
  );
  return result.rows.map((row) => ({ rating: row.rating, authorId: row.author_user_id }));
}

/** Audit hash zincirini doğrular (`POST /ops/audit-chain/verify`, yalnız ADMIN). */
export async function verifyAuditChain(admin: Pick<Actor, 'subject'>): Promise<{ status: string }> {
  return api<{ status: string }>('/ops/audit-chain/verify', bearerFor(admin), { body: {} });
}

/** Sağlayıcının randevu geçişi (ör. `PROVIDER_ARRIVING` — "Yola çıktım"). */
export async function providerTransition(
  provider: Pick<Actor, 'subject'>,
  bookingId: string,
  to: string,
): Promise<void> {
  await api(`/bookings/${bookingId}/transitions`, bearerFor(provider), { body: { to } });
}
