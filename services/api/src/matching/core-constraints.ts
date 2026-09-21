import type { MatchingCandidate, MatchingDemand, MatchingRankedCandidate } from './matching.port';

/**
 * Core tarafındaki hard constraint değerlendirmesi.
 *
 * Bu, AI servisindeki kontrolün kopyası değil **son savunmadır**. Kural
 * (ADR-0007 §4) "hard constraint ihlali hiçbir skorla telafi edilemez" ise, bu
 * kuralın doğruluğu karar motorunun doğru çalıştığı varsayımına bırakılamaz:
 * motor başka bir sürüme geçtiğinde, yanlış yapılandırıldığında veya yanıtı
 * bozulduğunda ihlalli bir sağlayıcı rezervasyona dönüşürdü.
 *
 * Aynı kod iki işi görür:
 * - motorun döndürdüğü atamayı **doğrular**,
 * - motor erişilemezken core'un yedek sıralamasını **filtreler**.
 *
 * Kritik nokta: burada değerlendirilen veriler core'un kendi SQL sorgusundan gelir,
 * motorun yanıtından değil. Motorun iddiasını motorun verisiyle doğrulamak denetim
 * değil, tekrar olurdu.
 */
export const CONSTRAINT_CODES = [
  'PROVIDER_NOT_VERIFIED',
  'SERVICE_NOT_OFFERED',
  'MISSING_REQUIRED_SKILL',
  'NOT_AVAILABLE',
  'BOOKING_CONFLICT',
  'OUTSIDE_SERVICE_AREA',
  'DISTANCE_LIMIT_EXCEEDED',
  'CAPACITY_EXCEEDED',
] as const;

export type ConstraintCode = (typeof CONSTRAINT_CODES)[number];

/** Hizmetin tamamen içine sığdığı zaman aralıkları. */
export function feasibleIntervals(
  demand: MatchingDemand,
  candidate: MatchingCandidate,
): { start: Date; end: Date }[] {
  const durationMs = demand.durationMinutes * 60_000;
  const intervals: { start: Date; end: Date }[] = [];

  for (const window of candidate.availability) {
    const start = Math.max(window.start.getTime(), demand.window.start.getTime());
    const end = Math.min(window.end.getTime(), demand.window.end.getTime());
    if (end - start < durationMs) {
      continue;
    }
    intervals.push({ start: new Date(start), end: new Date(end) });
  }

  intervals.sort((first, second) => first.start.getTime() - second.start.getTime());
  return intervals;
}

export function evaluateConstraints(
  demand: MatchingDemand,
  candidate: MatchingCandidate,
  options: { maxDistanceMeters: number },
): ConstraintCode[] {
  const violations: ConstraintCode[] = [];

  if (!candidate.verified) {
    violations.push('PROVIDER_NOT_VERIFIED');
  }
  if (!candidate.offersService) {
    violations.push('SERVICE_NOT_OFFERED');
  }

  const verified = new Set(candidate.verifiedSkills);
  if (!demand.requiredSkills.every((skill) => verified.has(skill))) {
    violations.push('MISSING_REQUIRED_SKILL');
  }
  if (candidate.hasConflictingBooking) {
    violations.push('BOOKING_CONFLICT');
  }
  if (feasibleIntervals(demand, candidate).length === 0) {
    violations.push('NOT_AVAILABLE');
  }
  if (!candidate.withinServiceArea) {
    violations.push('OUTSIDE_SERVICE_AREA');
  }
  if (candidate.distanceMeters > options.maxDistanceMeters) {
    violations.push('DISTANCE_LIMIT_EXCEEDED');
  }
  if (candidate.dailyBookingCount >= candidate.maxDailyBookings) {
    violations.push('CAPACITY_EXCEEDED');
  }

  return violations;
}

/**
 * Önerilen takvimin gerçekten müsait bir aralığın içinde olup olmadığı.
 *
 * Süre kontrolü ayrıdır: motor doğru sağlayıcıyı ama yanlış uzunlukta bir aralık
 * önerirse fiyat (süreden hesaplanır) ile takvim ayrışırdı.
 */
export function scheduleIsFeasible(
  demand: MatchingDemand,
  candidate: MatchingCandidate,
  schedule: { start: Date; end: Date },
): boolean {
  const minutes = (schedule.end.getTime() - schedule.start.getTime()) / 60_000;
  if (minutes !== demand.durationMinutes) {
    return false;
  }

  return feasibleIntervals(demand, candidate).some(
    (interval) =>
      interval.start.getTime() <= schedule.start.getTime() &&
      schedule.end.getTime() <= interval.end.getTime(),
  );
}

/**
 * Motor erişilemezken kullanılan **deterministik** yedek sıralama.
 *
 * ADR-0012 §3'teki matching baseline'ıyla aynıdır: kısıtları geçen adaylar mesafeye
 * göre sıralanır. Bilinçli olarak zayıftır — amacı en iyi kararı vermek değil,
 * sistemin cevapsız kalmamasıdır (ADR-0002 "graceful degrade").
 *
 * Skor bileşenleri **uydurulmaz**: yalnızca mesafe bileşeni hesaplanır, diğerleri
 * 0 kalır ve toplam skor mesafe bileşenine eşittir. Bu satırlar
 * `algorithm_version = 'fallback-distance-v1'` ile saklandığı için Ar-Ge
 * sorgularında motor kararlarıyla karışmaz.
 */
export const FALLBACK_ALGORITHM_VERSION = 'fallback-distance-v1';
export const FALLBACK_WEIGHTS_VERSION = 'weights-distance-v0';
export const FALLBACK_OBJECTIVE_VERSION = 'greedy-first-available-v0';

export function fallbackRanking(
  demand: MatchingDemand,
  options: { maxDistanceMeters: number },
): { eligible: MatchingRankedCandidate[]; eliminated: number } {
  const eligible = demand.candidates.filter(
    (candidate) => evaluateConstraints(demand, candidate, options).length === 0,
  );

  const ranked = [...eligible].sort((first, second) => {
    if (first.distanceMeters !== second.distanceMeters) {
      return first.distanceMeters - second.distanceMeters;
    }
    // Eşitlik açık bir kuralla çözülür; "önce geleni koru" örtük kuralı, aday
    // sırası değiştiğinde sonucu da değiştirirdi.
    return first.providerId.localeCompare(second.providerId);
  });

  return {
    eligible: ranked.map((candidate, index) => ({
      providerId: candidate.providerId,
      rank: index + 1,
      components: {
        skillScore: 0,
        availabilityScore: 0,
        qualityScore: 0,
        distanceScore: distanceScore(candidate.distanceMeters, options.maxDistanceMeters),
        ratingScore: 0,
        preferenceScore: 0,
      },
      overallScore: distanceScore(candidate.distanceMeters, options.maxDistanceMeters),
      explanation: [],
      distanceMeters: candidate.distanceMeters,
      // Rota servisi de bu modda kullanılmaz: süre tahmini yoktur, 0 saklanır.
      travelSeconds: 0,
    })),
    eliminated: demand.candidates.length - ranked.length,
  };
}

function distanceScore(distanceMeters: number, maxDistanceMeters: number): number {
  if (maxDistanceMeters <= 0) {
    return 0;
  }
  const score = 1 - distanceMeters / maxDistanceMeters;
  return Math.round(Math.min(1, Math.max(0, score)) * 10_000) / 10_000;
}
