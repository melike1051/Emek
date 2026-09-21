import {
  evaluateConstraints,
  fallbackRanking,
  feasibleIntervals,
  scheduleIsFeasible,
} from './core-constraints';
import type { MatchingCandidate, MatchingDemand } from './matching.port';

const EPOCH = new Date('2026-10-05T06:00:00.000Z');

function at(hours: number): Date {
  return new Date(EPOCH.getTime() + hours * 3_600_000);
}

function candidate(overrides: Partial<MatchingCandidate> = {}): MatchingCandidate {
  return {
    providerId: '00000000-0000-0000-0000-000000000001',
    verified: true,
    offersService: true,
    verifiedSkills: ['derin-temizlik'],
    availability: [{ start: EPOCH, end: at(8) }],
    hasConflictingBooking: false,
    withinServiceArea: true,
    distanceMeters: 2_000,
    dailyBookingCount: 0,
    maxDailyBookings: 2,
    skillLevels: { 'derin-temizlik': 'EXPERT' },
    ratingAvg: 4.6,
    ratingCount: 20,
    qualityScore: 0.9,
    completedBookings: 40,
    homeLocation: { latitude: 41.01, longitude: 29.01 },
    ...overrides,
  };
}

function demand(overrides: Partial<MatchingDemand> = {}): MatchingDemand {
  return {
    requestId: '00000000-0000-0000-0000-0000000003e8',
    serviceSlug: 'detayli-temizlik',
    durationMinutes: 180,
    window: { start: EPOCH, end: at(8) },
    location: { latitude: 41, longitude: 29 },
    requiredSkills: ['derin-temizlik'],
    preferredSkills: [],
    candidates: [candidate()],
    ...overrides,
  };
}

const OPTIONS = { maxDistanceMeters: 50_000 };

describe('core hard constraints', () => {
  it('geçerli adayda ihlal bulmaz', () => {
    expect(evaluateConstraints(demand(), candidate(), OPTIONS)).toEqual([]);
  });

  it.each([
    [{ verified: false }, 'PROVIDER_NOT_VERIFIED'],
    [{ offersService: false }, 'SERVICE_NOT_OFFERED'],
    [{ verifiedSkills: [] }, 'MISSING_REQUIRED_SKILL'],
    [{ hasConflictingBooking: true }, 'BOOKING_CONFLICT'],
    [{ availability: [] }, 'NOT_AVAILABLE'],
    [{ withinServiceArea: false }, 'OUTSIDE_SERVICE_AREA'],
    [{ distanceMeters: 60_000 }, 'DISTANCE_LIMIT_EXCEEDED'],
    [{ dailyBookingCount: 2, maxDailyBookings: 2 }, 'CAPACITY_EXCEEDED'],
  ])('%j ihlali tespit edilir', (overrides, expected) => {
    expect(evaluateConstraints(demand(), candidate(overrides), OPTIONS)).toContain(expected);
  });

  it('kısmi örtüşen müsaitlik yeterli değildir', () => {
    // 2 saatlik pencere, 3 saatlik hizmet: kesişim var ama süre sığmıyor.
    const short = candidate({ availability: [{ start: EPOCH, end: at(2) }] });

    expect(evaluateConstraints(demand(), short, OPTIONS)).toContain('NOT_AVAILABLE');
    expect(feasibleIntervals(demand(), short)).toEqual([]);
  });

  it('uygun aralıklar talep penceresine kırpılır', () => {
    const wide = candidate({ availability: [{ start: at(-4), end: at(20) }] });

    const intervals = feasibleIntervals(demand({ window: { start: at(1), end: at(6) } }), wide);

    expect(intervals).toEqual([{ start: at(1), end: at(6) }]);
  });

  it('mesafe sınırı dâhil, bir metre ötesi hariçtir', () => {
    expect(evaluateConstraints(demand(), candidate({ distanceMeters: 50_000 }), OPTIONS)).toEqual(
      [],
    );
    expect(evaluateConstraints(demand(), candidate({ distanceMeters: 50_001 }), OPTIONS)).toContain(
      'DISTANCE_LIMIT_EXCEEDED',
    );
  });
});

describe('takvim doğrulaması', () => {
  it('müsait aralığın içindeki takvimi kabul eder', () => {
    expect(scheduleIsFeasible(demand(), candidate(), { start: at(1), end: at(4) })).toBe(true);
  });

  it('müsait aralığın dışına taşan takvimi reddeder', () => {
    const late = candidate({ availability: [{ start: at(6), end: at(8) }] });

    expect(scheduleIsFeasible(demand(), late, { start: at(6), end: at(9) })).toBe(false);
  });

  it('süresi talebe uymayan takvimi reddeder', () => {
    // Fiyat süreden hesaplanır: yanlış uzunluk, takvim ile fiyatı ayrıştırırdı.
    expect(scheduleIsFeasible(demand(), candidate(), { start: at(1), end: at(2) })).toBe(false);
  });
});

describe('yedek sıralama', () => {
  it('ihlalli adayları eler ve mesafeye göre sıralar', () => {
    const far = candidate({
      providerId: '00000000-0000-0000-0000-00000000000a',
      distanceMeters: 30_000,
    });
    const near = candidate({
      providerId: '00000000-0000-0000-0000-00000000000b',
      distanceMeters: 1_000,
    });
    const invalid = candidate({
      providerId: '00000000-0000-0000-0000-00000000000c',
      verified: false,
      distanceMeters: 10,
    });

    const result = fallbackRanking(demand({ candidates: [far, near, invalid] }), OPTIONS);

    expect(result.eligible.map((entry) => entry.providerId)).toEqual([
      near.providerId,
      far.providerId,
    ]);
    expect(result.eliminated).toBe(1);
  });

  it('eşit mesafede sıra sağlayıcı kimliğiyle deterministik olarak çözülür', () => {
    const second = candidate({ providerId: '00000000-0000-0000-0000-000000000002' });
    const first = candidate({ providerId: '00000000-0000-0000-0000-000000000001' });

    const forward = fallbackRanking(demand({ candidates: [second, first] }), OPTIONS);
    const backward = fallbackRanking(demand({ candidates: [first, second] }), OPTIONS);

    expect(forward.eligible.map((entry) => entry.providerId)).toEqual([
      first.providerId,
      second.providerId,
    ]);
    expect(forward).toEqual(backward);
  });

  it('skor bileşenlerini uydurmaz: yalnızca mesafe hesaplanır', () => {
    const result = fallbackRanking(demand({ candidates: [candidate()] }), OPTIONS);
    const entry = result.eligible[0];

    expect(entry).toBeDefined();
    expect(entry?.components.skillScore).toBe(0);
    expect(entry?.components.ratingScore).toBe(0);
    expect(entry?.components.distanceScore).toBeGreaterThan(0);
    expect(entry?.overallScore).toBe(entry?.components.distanceScore);
  });

  it('uygun aday yoksa boş sıralama döner', () => {
    const result = fallbackRanking(
      demand({ candidates: [candidate({ verified: false }), candidate({ availability: [] })] }),
      OPTIONS,
    );

    expect(result.eligible).toEqual([]);
    expect(result.eliminated).toBe(2);
  });
});
