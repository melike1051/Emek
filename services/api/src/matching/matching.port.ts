/**
 * Matching portu (ADR-0002, ADR-0007).
 *
 * Core, karar motorunun **ne olduğunu** bilmez: OR-Tools tabanlı bir servis de
 * olabilir, başka bir çözücü de. Bildiği tek şey "aday havuzu + talep → sıralama +
 * atama" dönüşümü ve bu dönüşümün **başarısız olabileceğidir**.
 *
 * NLP portuyla aynı kural: motor bir **öneridir**, karar değil. Çıktısı core'un kendi
 * doğrulamasından geçer — atanan sağlayıcı gerçekten aday havuzunda mıydı, gerçekten
 * müsait mi, rezervasyon yazılabiliyor mu. Motor erişilemezse core kendi deterministik
 * yedek sıralamasıyla devam eder (ADR-0002 "graceful degrade").
 */

/** Sağlayıcının yetkinlik seviyesi — `provider_skills.level` ile aynı küme. */
export const SKILL_LEVELS = ['BEGINNER', 'INTERMEDIATE', 'EXPERT'] as const;
export type MatchingSkillLevel = (typeof SKILL_LEVELS)[number];

export interface MatchingLocation {
  latitude: number;
  longitude: number;
}

export interface MatchingInterval {
  start: Date;
  end: Date;
}

/**
 * Bir sağlayıcının **bu talep için** hesaplanmış özellikleri.
 *
 * Kişisel veri taşımaz: ad, telefon, adres satırı yoktur. Sağlayıcı kimliği bir
 * UUID'dir; konum karar için gereken koordinattır, adres değil.
 */
export interface MatchingCandidate {
  providerId: string;
  verified: boolean;
  offersService: boolean;
  verifiedSkills: string[];
  /**
   * Müsaitlik pencereleri, **istisnalar ve mevcut rezervasyonlar düşülmüş** hâlde.
   *
   * Çıkarma veri katmanında (multirange farkı) yapılır: "çakışan rezervasyonu olan
   * sağlayıcıyı tamamen ele" kuralı, sabah 2 saatlik işi olan bir sağlayıcıyı tüm gün
   * için elerdi. Kalan boşluk hizmete yetmiyorsa aday zaten müsaitlik kısıtından eleniyor.
   */
  availability: MatchingInterval[];
  /**
   * Takvim çakışması nedeniyle elenmesi gereken aday.
   *
   * Müsaitlikten çıkarma sayesinde normal yolda bu bayrak yalnızca "aktif bir
   * rezervasyon var **ve** geriye hizmete yetecek boşluk kalmadı" durumunda true olur.
   * Ayrı bir bayrak olması elenme nedenini kesinleştirir: `BOOKING_CONFLICT` ile
   * `NOT_AVAILABLE` operasyonel olarak farklı şeylerdir.
   */
  hasConflictingBooking: boolean;
  withinServiceArea: boolean;
  distanceMeters: number;
  dailyBookingCount: number;
  maxDailyBookings: number;
  skillLevels: Record<string, MatchingSkillLevel>;
  ratingAvg: number | null;
  ratingCount: number;
  qualityScore: number | null;
  completedBookings: number;
  homeLocation: MatchingLocation | null;
}

export interface MatchingDemand {
  requestId: string;
  serviceSlug: string;
  durationMinutes: number;
  window: MatchingInterval;
  location: MatchingLocation;
  requiredSkills: string[];
  preferredSkills: string[];
  candidates: MatchingCandidate[];
}

export interface MatchingScoreComponents {
  skillScore: number;
  availabilityScore: number;
  qualityScore: number;
  distanceScore: number;
  ratingScore: number;
  preferenceScore: number;
}

export interface MatchingExplanationReason {
  code: string;
  value: number | null;
}

export interface MatchingRankedCandidate {
  providerId: string;
  rank: number;
  components: MatchingScoreComponents;
  overallScore: number;
  explanation: MatchingExplanationReason[];
  distanceMeters: number;
  travelSeconds: number;
}

export interface MatchingRanking {
  requestId: string;
  candidates: MatchingRankedCandidate[];
  eliminatedCount: number;
  evaluatedCount: number;
}

export interface MatchingAssignment {
  requestId: string;
  providerId: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  travelSeconds: number;
  distanceMeters: number;
  rank: number;
}

export const MATCHING_STRATEGIES = ['OPTIMIZED', 'RANKED_FALLBACK', 'RANKING_ONLY'] as const;
export type MatchingStrategy = (typeof MATCHING_STRATEGIES)[number];

export const MATCHING_DEGRADED_REASONS = [
  'OPTIMIZATION_TIMEOUT',
  'OPTIMIZATION_INFEASIBLE',
  'OPTIMIZATION_ERROR',
  'ROUTING_UNAVAILABLE',
  'ENGINE_UNAVAILABLE',
  'ENGINE_CONTRACT_MISMATCH',
] as const;
export type MatchingDegradedReason = (typeof MATCHING_DEGRADED_REASONS)[number];

export interface MatchingSolution {
  algorithmVersion: string;
  weightsVersion: string;
  objectiveVersion: string;
  strategy: MatchingStrategy;
  degradedReason: MatchingDegradedReason | null;
  routingProvider: string;
  rankings: MatchingRanking[];
  assignments: MatchingAssignment[];
  constraintViolations: number;
  optimizationRuntimeMs: number;
}

export type MatchingOutcome =
  | { status: 'SOLVED'; solution: MatchingSolution }
  /**
   * Motor kullanılabilir bir sonuç vermedi: çağıran yedek sıralamaya düşer.
   *
   * `CONTRACT_MISMATCH` diğerlerinden **ayrı** tutulur ve bu ayrım önemlidir:
   * zaman aşımı ya da bağlantı hatası bir işletme durumudur (servis yavaş/kapalı),
   * 4xx ise bir **hatadır** — iki servisin sözleşmesi ayrışmıştır. İkisi aynı
   * kovaya konsaydı, katalogda yeni bir hizmet açmayı unutulmuş bir şema güncellemesi
   * "AI servisi kapalı" gibi görünür ve sistem kalıcı olarak mesafeye göre
   * eşleştirmeye düşerken kimse fark etmezdi.
   */
  | {
      status: 'UNAVAILABLE';
      reason: 'TIMEOUT' | 'TRANSPORT' | 'INVALID_RESPONSE' | 'CONTRACT_MISMATCH';
    };

export interface MatchingClient {
  solve(input: { demands: MatchingDemand[]; optimize: boolean }): Promise<MatchingOutcome>;
}

export const MATCHING_CLIENT = Symbol('MATCHING_CLIENT');
