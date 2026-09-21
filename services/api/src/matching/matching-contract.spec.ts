import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HttpMatchingClient } from './http-matching.client';
import type { MatchingDemand } from './matching.port';

/**
 * Servisler arası sözleşme testi — core tarafı.
 *
 * `packages/api-contracts/matching/` altındaki fixture'lar bu istemcinin **gerçek**
 * çıktısı ve AI servisinin **gerçek** yanıtıdır. Aynı dosyalar AI tarafında da
 * (`tests/test_matching_contract.py`) doğrulanır.
 *
 * Neden gerekli: iki servis ayrı CI işlerinde koşuyor ve hiçbir test ikisini birlikte
 * ayağa kaldırmıyor. Alan adlandırmasında sessiz bir sapma üretimde **bozulmuş moda
 * düşmek** olarak görünürdü: core her çağrıda `INVALID_RESPONSE` alır, kendi yedek
 * sıralamasına düşer ve hiçbir test kırılmaz. Kullanıcı yalnızca daha kötü
 * eşleşmeler görür — sessiz bir kalite kaybı.
 */
const CONTRACT_DIR = resolve(__dirname, '../../../../packages/api-contracts/matching');

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(CONTRACT_DIR, name), 'utf8')) as Record<string, unknown>;
}

const START = new Date('2026-10-05T06:00:00.000Z');
const END = new Date('2026-10-05T14:00:00.000Z');

/** Fixture'ı üreten talep. Değişirse fixture da yenilenmelidir. */
const DEMAND: MatchingDemand = {
  requestId: '00000000-0000-0000-0000-0000000003e8',
  serviceSlug: 'detayli-temizlik',
  durationMinutes: 180,
  window: { start: START, end: END },
  location: { latitude: 41, longitude: 29 },
  requiredSkills: ['derin-temizlik'],
  preferredSkills: ['utu'],
  candidates: [
    {
      providerId: '00000000-0000-0000-0000-000000000001',
      verified: true,
      offersService: true,
      verifiedSkills: ['derin-temizlik', 'utu'],
      availability: [{ start: START, end: END }],
      hasConflictingBooking: false,
      withinServiceArea: true,
      distanceMeters: 2000,
      dailyBookingCount: 0,
      maxDailyBookings: 2,
      skillLevels: { 'derin-temizlik': 'EXPERT', utu: 'INTERMEDIATE' },
      ratingAvg: 4.7,
      ratingCount: 25,
      qualityScore: 0.9,
      completedBookings: 40,
      homeLocation: { latitude: 41.01, longitude: 29.01 },
    },
    {
      providerId: '00000000-0000-0000-0000-000000000002',
      verified: true,
      offersService: true,
      verifiedSkills: ['derin-temizlik'],
      availability: [{ start: START, end: END }],
      hasConflictingBooking: false,
      withinServiceArea: true,
      distanceMeters: 22000,
      dailyBookingCount: 0,
      maxDailyBookings: 2,
      skillLevels: { 'derin-temizlik': 'BEGINNER' },
      ratingAvg: null,
      ratingCount: 0,
      qualityScore: null,
      completedBookings: 0,
      homeLocation: null,
    },
  ],
};

describe('matching servisler arası sözleşme', () => {
  const config = {
    env: {
      AI_SERVICE_URL: 'http://ai.local',
      MATCHING_SERVICE_TIMEOUT_MS: 1000,
      MATCHING_MAX_DISTANCE_METERS: 50000,
    },
  } as never;
  const logger = { warn: jest.fn() } as never;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('istemcinin ürettiği gövde, commit edilmiş istek fixture.ı ile aynıdır', async () => {
    let captured: unknown;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      captured = JSON.parse(init?.body as string);
      return new Response(JSON.stringify(fixture('solve-response.json')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const client = new HttpMatchingClient(config, logger);
    await client.solve({ demands: [DEMAND], optimize: true });

    // Fark varsa: ya alan adı değişti (AI servisi bunu anlamaz) ya da fixture bayat.
    expect(captured).toEqual(fixture('solve-request.json'));
  });

  it('AI servisinin gerçek yanıtı core sözleşmesine çevrilebilir', async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify(fixture('solve-response.json')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    const client = new HttpMatchingClient(config, logger);
    const outcome = await client.solve({ demands: [DEMAND], optimize: true });

    // `INVALID_RESPONSE` burada en tehlikeli sonuçtur: üretimde sessizce bozulmuş
    // moda düşmek demek olurdu.
    expect(outcome.status).toBe('SOLVED');
  });

  it('gerçek yanıttan tüm skor bileşenleri ve atama okunur', async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify(fixture('solve-response.json')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    const client = new HttpMatchingClient(config, logger);
    const outcome = await client.solve({ demands: [DEMAND], optimize: true });

    if (outcome.status !== 'SOLVED') {
      throw new Error('sözleşme fixture.ı çözülemedi');
    }

    const ranked = outcome.solution.rankings[0]?.candidates ?? [];
    expect(ranked.length).toBeGreaterThan(0);

    const first = ranked[0];
    expect(first?.components).toEqual({
      skillScore: expect.any(Number),
      availabilityScore: expect.any(Number),
      qualityScore: expect.any(Number),
      distanceScore: expect.any(Number),
      ratingScore: expect.any(Number),
      preferenceScore: expect.any(Number),
    });
    expect(first?.explanation.length).toBeGreaterThan(0);

    const assignment = outcome.solution.assignments[0];
    expect(assignment?.providerId).toEqual(expect.any(String));
    expect(assignment?.scheduledStart).toBeInstanceOf(Date);
    expect(assignment?.scheduledEnd.getTime()).toBeGreaterThan(
      assignment!.scheduledStart.getTime(),
    );
  });

  it('sürüm alanları taşınır (ADR-0012 §1)', async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify(fixture('solve-response.json')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    const client = new HttpMatchingClient(config, logger);
    const outcome = await client.solve({ demands: [DEMAND], optimize: true });

    if (outcome.status !== 'SOLVED') {
      throw new Error('sözleşme fixture.ı çözülemedi');
    }

    expect(outcome.solution.algorithmVersion).toBeTruthy();
    expect(outcome.solution.weightsVersion).toBeTruthy();
    expect(outcome.solution.objectiveVersion).toBeTruthy();
  });
});
