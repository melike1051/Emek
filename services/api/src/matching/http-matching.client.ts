import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { AppConfigService } from '../common/config/app-config.service';
import { ROOT_LOGGER } from '../common/logging/logging.tokens';
import {
  MATCHING_DEGRADED_REASONS,
  MATCHING_STRATEGIES,
  type MatchingAssignment,
  type MatchingClient,
  type MatchingDegradedReason,
  type MatchingDemand,
  type MatchingExplanationReason,
  type MatchingOutcome,
  type MatchingRankedCandidate,
  type MatchingRanking,
  type MatchingScoreComponents,
  type MatchingSolution,
  type MatchingStrategy,
} from './matching.port';

/** Art arda bu kadar altyapı hatasından sonra devre açılır (anomali istemcisiyle aynı). */
const CIRCUIT_FAILURE_THRESHOLD = 5;
/** Devrenin kapalı kalma süresi; dolunca tek bir deneme yapılır (yarı açık). */
const CIRCUIT_OPEN_MS = 30_000;

/**
 * AI servisine HTTP ile bağlanan matching istemcisi.
 *
 * `HttpNlpClient` ile aynı üç ilke geçerlidir ve gerekçeleri aynıdır:
 *
 * 1. **Timeout zorunludur.** Karar motoru yavaşladığında talep akışı onunla birlikte
 *    yavaşlayamaz; süre dolduğunda core kendi yedek sıralamasına düşer.
 * 2. **Yanıt yeniden doğrulanır.** Motor kendi şemasını uygular ama core ona güvenmez:
 *    skor aralığı, sürüm alanlarının varlığı ve strateji değeri burada tekrar
 *    kontrol edilir. "Karşı taraf zaten doğruluyor" varsayımı iki servis sürümü
 *    ayrıştığında sessizce bozulur.
 * 3. **Hata yükseltilmez.** Motorun erişilemezliği bir iş hatası değildir: çağıran
 *    bunu bir sonuç olarak alır ve bozulmuş modda devam eder.
 *
 * Ek olarak: atanan sağlayıcının gerçekten aday havuzunda olduğu ve kısıtları
 * sağladığı **serviste** yeniden doğrulanır. Bu istemci taşıma katmanıdır, karar
 * doğrulayıcısı değil.
 */
@Injectable()
export class HttpMatchingClient implements MatchingClient {
  constructor(
    private readonly config: AppConfigService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Devre kesici — `HttpAnomalyClient` ile **aynı** desen ve aynı gerekçe (Faz 8).
   *
   * Faz 14 ölçümü (EXP-007 §S-11) bunu zorunlu kıldı: motor **asılı kaldığında**
   * (bağlantı kabul ediliyor, yanıt hiç gelmiyor) her eşleştirme isteği zaman aşımı
   * bütçesinin tamamını ödüyordu — sağlıklı p50 ~10 ms iken 1038 ms. Sonuç zaten
   * bozulmuş moda düşecekti; kullanıcı bu bedeli **her istekte** yeniden ödüyordu.
   *
   * Reddedilen bağlantı (hızlı hata) bu sorunu üretmez; ölçülen ve düzeltilen şey
   * sessizce asılı kalan bağımlılıktır.
   *
   * **Gerçek yarı-açık.** Süre dolduğunda kapı kendiliğinden açılmaz: deneme
   * yapılmadan **önce** pencere yeniden ileri atılır, böylece o anda uçuşta olan
   * diğer istekler geçemez. Aksi hâlde kesici "tek deneme" değil, 30 saniyede bir
   * tekrarlanan **eşzamanlı sel** olurdu ve her seli N× tam zaman aşımı öderdik —
   * yani düzeltilmek istenen maliyet görev döngüsüne çevrilmiş olurdu.
   *
   * Yalnızca **altyapı** hataları (`TIMEOUT`, `TRANSPORT`) devreyi açar. Sözleşme
   * hataları (4xx → `CONTRACT_MISMATCH`) ve geçersiz yanıt (`INVALID_RESPONSE`)
   * açmaz: onlar kesinti değil, şema ayrışmasıdır ve susturulmak yerine her
   * istekte görünür kalmalıdır.
   */
  private consecutiveFailures = 0;
  private openUntil = 0;

  async solve(
    input: { demands: MatchingDemand[]; optimize: boolean },
    now: number = Date.now(),
  ): Promise<MatchingOutcome> {
    if (now < this.openUntil) {
      return { status: 'UNAVAILABLE', reason: 'CIRCUIT_OPEN' };
    }

    // Pencere dolmuş ama devre hâlâ açıksa bu istek **deneme**dir: kapı, sonuç
    // belli olana kadar kapalı tutulur.
    const isProbe = this.openUntil > 0;
    if (isProbe) {
      this.openUntil = now + CIRCUIT_OPEN_MS;
    }

    const outcome = await this.call(input);

    const infrastructureFailure =
      outcome.status === 'UNAVAILABLE' &&
      (outcome.reason === 'TIMEOUT' || outcome.reason === 'TRANSPORT');

    if (!infrastructureFailure) {
      // Başarı (ya da kesinti olmayan bir hata) devreyi kapatır: deneme tuttu.
      this.consecutiveFailures = 0;
      this.openUntil = 0;
      return outcome;
    }

    if (isProbe) {
      // Deneme de düştü; pencere yukarıda zaten yeniden kuruldu.
      return outcome;
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
      this.openUntil = now + CIRCUIT_OPEN_MS;
      this.consecutiveFailures = 0;
      this.logger.warn({ openMs: CIRCUIT_OPEN_MS }, 'matching servisi devre kesicisi açıldı');
    }

    return outcome;
  }

  private async call(input: {
    demands: MatchingDemand[];
    optimize: boolean;
  }): Promise<MatchingOutcome> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.config.env.MATCHING_SERVICE_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.config.env.AI_SERVICE_URL}/api/v1/matching/solve`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.env.AI_SERVICE_API_KEY !== undefined
            ? { 'x-service-key': this.config.env.AI_SERVICE_API_KEY }
            : {}),
        },
        body: JSON.stringify({
          demands: input.demands.map((demand) => this.toWire(demand)),
          optimize: input.optimize,
          // Mesafe sınırı **istekle birlikte** gider. İki serviste ayrı
          // yapılandırılsaydı sapma sessiz olurdu: eleme core'un değerine,
          // `distance_score` motorun değerine göre hesaplanır ve saklanan her skor
          // bileşeni fark ettirmeden bozulurdu.
          max_distance_meters: this.config.env.MATCHING_MAX_DISTANCE_METERS,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // 4xx, motorun isteği **anlamadığı** anlamına gelir: iki servisin şeması
        // ayrışmıştır (ör. katalogda yeni bir hizmet açıldı ama motorun kapalı
        // slug kümesine eklenmedi). Bu bir kesinti değil, bir hatadır — ve kesinti
        // gibi raporlanırsa sonsuza kadar bozulmuş modda çalışılır.
        if (response.status >= 400 && response.status < 500) {
          this.logger.error(
            { status: response.status },
            'matching servisi isteği reddetti: sözleşme uyuşmazlığı',
          );
          return { status: 'UNAVAILABLE', reason: 'CONTRACT_MISMATCH' };
        }

        this.logger.warn({ status: response.status }, 'matching servisi hata döndürdü');
        return { status: 'UNAVAILABLE', reason: 'INVALID_RESPONSE' };
      }

      const solution = this.toSolution(await response.json());
      if (solution === null) {
        return { status: 'UNAVAILABLE', reason: 'INVALID_RESPONSE' };
      }
      return { status: 'SOLVED', solution };
    } catch (error) {
      const reason = controller.signal.aborted ? 'TIMEOUT' : 'TRANSPORT';
      // Talep içeriği loglanmaz: konum ve tercih kişisel veridir.
      this.logger.warn({ reason }, 'matching servisine ulaşılamadı');
      void error;
      return { status: 'UNAVAILABLE', reason };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Domain modelini servis sözleşmesine (snake_case) çevirir. */
  private toWire(demand: MatchingDemand): Record<string, unknown> {
    return {
      request_id: demand.requestId,
      service_type: demand.serviceSlug,
      duration_minutes: demand.durationMinutes,
      window: {
        start: demand.window.start.toISOString(),
        end: demand.window.end.toISOString(),
      },
      location: demand.location,
      required_skills: demand.requiredSkills,
      preferred_skills: demand.preferredSkills,
      candidates: demand.candidates.map((candidate) => ({
        provider_id: candidate.providerId,
        verified: candidate.verified,
        offers_service: candidate.offersService,
        verified_skills: candidate.verifiedSkills,
        availability: candidate.availability.map((window) => ({
          start: window.start.toISOString(),
          end: window.end.toISOString(),
        })),
        has_conflicting_booking: candidate.hasConflictingBooking,
        within_service_area: candidate.withinServiceArea,
        distance_meters: candidate.distanceMeters,
        daily_booking_count: candidate.dailyBookingCount,
        max_daily_bookings: candidate.maxDailyBookings,
        skill_levels: candidate.skillLevels,
        rating_avg: candidate.ratingAvg,
        rating_count: candidate.ratingCount,
        quality_score: candidate.qualityScore,
        completed_bookings: candidate.completedBookings,
        home_location: candidate.homeLocation,
      })),
    };
  }

  private toSolution(payload: unknown): MatchingSolution | null {
    if (typeof payload !== 'object' || payload === null) {
      return null;
    }
    const body = payload as Record<string, unknown>;

    const algorithmVersion = readVersion(body.algorithm_version);
    const weightsVersion = readVersion(body.weights_version);
    const objectiveVersion = readVersion(body.objective_version);
    if (algorithmVersion === null || weightsVersion === null || objectiveVersion === null) {
      // Sürümsüz bir karar `booking_match_results`'a yazılamaz (ADR-0012 §1).
      return null;
    }

    const strategy = body.strategy;
    if (
      typeof strategy !== 'string' ||
      !(MATCHING_STRATEGIES as readonly string[]).includes(strategy)
    ) {
      return null;
    }

    const routingProvider = body.routing_provider;
    if (typeof routingProvider !== 'string' || routingProvider.length === 0) {
      return null;
    }

    const rankings = this.toRankings(body.rankings);
    if (rankings === null) {
      return null;
    }

    const assignments = this.toAssignments(body.assignments);
    if (assignments === null) {
      return null;
    }

    return {
      algorithmVersion,
      weightsVersion,
      objectiveVersion,
      strategy: strategy as MatchingStrategy,
      degradedReason: readDegradedReason(body.degraded_reason),
      routingProvider: routingProvider.slice(0, 32),
      rankings,
      assignments,
      constraintViolations: readCount(body.constraint_violations),
      optimizationRuntimeMs: readCount(body.optimization_runtime_ms),
    };
  }

  private toRankings(value: unknown): MatchingRanking[] | null {
    if (!Array.isArray(value)) {
      return null;
    }

    const rankings: MatchingRanking[] = [];
    for (const item of value) {
      if (typeof item !== 'object' || item === null) {
        return null;
      }
      const entry = item as Record<string, unknown>;
      if (typeof entry.request_id !== 'string') {
        return null;
      }

      const candidates = this.toCandidates(entry.candidates);
      if (candidates === null) {
        return null;
      }

      rankings.push({
        requestId: entry.request_id,
        candidates,
        eliminatedCount: Array.isArray(entry.eliminated) ? entry.eliminated.length : 0,
        evaluatedCount: readCount(entry.evaluated_count),
      });
    }
    return rankings;
  }

  private toCandidates(value: unknown): MatchingRankedCandidate[] | null {
    if (!Array.isArray(value)) {
      return null;
    }

    const candidates: MatchingRankedCandidate[] = [];
    for (const item of value) {
      if (typeof item !== 'object' || item === null) {
        return null;
      }
      const entry = item as Record<string, unknown>;

      const components = toComponents(entry.components);
      const overall = readUnit(entry.overall_score);
      const rank = readCount(entry.rank);

      if (
        typeof entry.provider_id !== 'string' ||
        components === null ||
        overall === null ||
        rank < 1
      ) {
        return null;
      }

      candidates.push({
        providerId: entry.provider_id,
        rank,
        components,
        overallScore: overall,
        explanation: toExplanation(entry.explanation),
        distanceMeters: readCount(entry.distance_meters),
        travelSeconds: readCount(entry.travel_seconds),
      });
    }
    return candidates;
  }

  private toAssignments(value: unknown): MatchingAssignment[] | null {
    if (!Array.isArray(value)) {
      return null;
    }

    const assignments: MatchingAssignment[] = [];
    for (const item of value) {
      if (typeof item !== 'object' || item === null) {
        return null;
      }
      const entry = item as Record<string, unknown>;

      const start = readDate(entry.scheduled_start);
      const end = readDate(entry.scheduled_end);

      if (
        typeof entry.request_id !== 'string' ||
        typeof entry.provider_id !== 'string' ||
        start === null ||
        end === null ||
        end.getTime() <= start.getTime()
      ) {
        return null;
      }

      assignments.push({
        requestId: entry.request_id,
        providerId: entry.provider_id,
        scheduledStart: start,
        scheduledEnd: end,
        travelSeconds: readCount(entry.travel_seconds),
        distanceMeters: readCount(entry.distance_meters),
        rank: Math.max(1, readCount(entry.rank)),
      });
    }
    return assignments;
  }
}

function readVersion(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null;
}

function readDegradedReason(value: unknown): MatchingDegradedReason | null {
  if (
    typeof value !== 'string' ||
    !(MATCHING_DEGRADED_REASONS as readonly string[]).includes(value)
  ) {
    return null;
  }
  return value as MatchingDegradedReason;
}

/** Negatif olmayan tam sayı; aksi hâlde 0. Sayaçlar veritabanında CHECK ile sınırlı. */
function readCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

/** [0, 1] aralığında skor; aksi hâlde null (yanıt reddedilir). */
function readUnit(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    return null;
  }
  return value;
}

function readDate(value: unknown): Date | null {
  if (typeof value !== 'string') {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toComponents(value: unknown): MatchingScoreComponents | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const entry = value as Record<string, unknown>;

  const skill = readUnit(entry.skill_score);
  const availability = readUnit(entry.availability_score);
  const quality = readUnit(entry.quality_score);
  const distance = readUnit(entry.distance_score);
  const rating = readUnit(entry.rating_score);
  const preference = readUnit(entry.preference_score);

  if (
    skill === null ||
    availability === null ||
    quality === null ||
    distance === null ||
    rating === null ||
    preference === null
  ) {
    return null;
  }

  return {
    skillScore: skill,
    availabilityScore: availability,
    qualityScore: quality,
    distanceScore: distance,
    ratingScore: rating,
    preferenceScore: preference,
  };
}

/**
 * Açıklama gerekçeleri.
 *
 * Kod kapalı küme olduğu için burada yalnızca **biçim** doğrulanır; bilinmeyen bir
 * kod sessizce düşer. Açıklamanın eksik kalması kararı geçersiz kılmaz — açıklama
 * kararın yan ürünüdür, kararın kendisi değil.
 */
function toExplanation(value: unknown): MatchingExplanationReason[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null) {
      return [];
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.code !== 'string' || entry.code.length > 64) {
      return [];
    }
    return [
      {
        code: entry.code,
        value: typeof entry.value === 'number' && Number.isFinite(entry.value) ? entry.value : null,
      },
    ];
  });
}
