import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { BookingsService } from '../bookings/bookings.service';
import { BookingStateService } from '../bookings/state/booking-state.service';
import { AuditAction, AuditService } from '../common/audit/audit.service';
import { AppConfigService } from '../common/config/app-config.service';
import { UnitOfWork } from '../common/database/unit-of-work';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { EventType, OutboxService } from '../common/outbox/outbox.service';
import {
  FALLBACK_ALGORITHM_VERSION,
  FALLBACK_OBJECTIVE_VERSION,
  FALLBACK_WEIGHTS_VERSION,
  evaluateConstraints,
  fallbackRanking,
  scheduleIsFeasible,
} from './core-constraints';
import {
  MATCHING_CLIENT,
  type MatchingAssignment,
  type MatchingCandidate,
  type MatchingClient,
  type MatchingDegradedReason,
  type MatchingDemand,
  type MatchingRankedCandidate,
  type MatchingStrategy,
} from './matching.port';
import { MatchingRepository, type MatchingRequestContext } from './matching.repository';

/**
 * Eşleştirmeye izin verilen talep durumları.
 *
 * `MATCHED` bilinçli olarak dışarıda: zaten eşleşmiş bir talebi yeniden eşleştirmek
 * ikinci bir rezervasyon üretirdi. Tekrar çağrı mevcut sonucu döndürür (idempotency).
 */
const MATCHABLE_STATUSES = new Set(['CREATED', 'MATCHING']);

/**
 * Eşleştirme için gereken asgari ayrıştırma güveni.
 *
 * `BookingRequestsService.MIN_AUTO_CONFIDENCE` ile aynı eşik, **ikinci** kez burada
 * uygulanır: talep oluşturma kapısı aşılsa bile (veri göçü, elle düzeltme, ileride
 * eklenecek bir yol) düşük güvenli bir ayrıştırmayla sağlayıcı aranmamalı. Yanlış
 * anlaşılmış bir talebin bedeli, sağlayıcı kapıya geldiğinde ödenir.
 */
const MIN_MATCHING_CONFIDENCE = 0.6;

export interface MatchOutcome {
  runId: string;
  requestId: string;
  algorithmVersion: string;
  weightsVersion: string;
  objectiveVersion: string;
  strategy: MatchingStrategy;
  degradedReason: MatchingDegradedReason | null;
  candidateCount: number;
  eligibleCount: number;
  constraintViolations: number;
  retrievalMs: number;
  decisionMs: number;
  /** Atama yapıldıysa oluşan rezervasyon. */
  bookingId: string | null;
  selectedProviderId: string | null;
  selectedProviderName: string | null;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  explanation: { code: string; value: number | null }[];
}

/**
 * Bir toplu çalıştırma boyunca biriken durum.
 *
 * Kapasite ve takvim, tek tek taleplere bakarak doğrulanamaz: her talebin aday
 * verisi aynı anlık görüntüden gelir ve hiçbiri diğerinin atamasını bilmez.
 * Birikimli durum olmadan, aynı sağlayıcıya günlük sınırının üstünde iş vermek
 * hiçbir kontrole takılmazdı (EXCLUDE constraint yalnızca **çakışan** saatleri
 * yakalar; farklı saatlerdeki fazla iş ondan geçer).
 */
interface BatchState {
  /** `providerId:yerelGün` → bu çalıştırmada verilen rezervasyon sayısı. */
  capacity: Map<string, number>;
  /** `providerId` → bu çalıştırmada verilen takvim aralıkları. */
  scheduled: Map<string, { start: Date; end: Date }[]>;
}

interface PreparedDemand {
  context: MatchingRequestContext;
  demand: MatchingDemand;
  retrievalMs: number;
}

/**
 * Eşleştirme orkestrasyonu.
 *
 * Zincir ADR-0007'deki zincirdir ve her halkası **core'da** kalır:
 *
 *     aday havuzu (SQL/PostGIS) → motor (sıralama + optimizasyon) → doğrulama
 *     → rezervasyon → karar kaydı
 *
 * Motor bir öneri üretir; kararın sonucunu yazan core'dur. İki yer bu ayrımın
 * bedelini öder ve ikisi de bilinçlidir:
 *
 * 1. **Doğrulama tekrarı.** Motorun döndürdüğü atama core'un kendi kısıt
 *    değerlendirmesinden geçer. Geçmezse atama düşer, sayaç artar ve talep
 *    atanmamış sayılır — ihlalli bir sağlayıcı hiçbir koşulda rezervasyona dönüşmez.
 * 2. **Yedek sıralama.** Motor erişilemezse core kendi deterministik (mesafe
 *    sıralı) yedeğini kullanır ve sonucu `ENGINE_UNAVAILABLE` ile işaretler.
 *    İşaretsiz bir bozulma, bozulmayı ölçülemez kılardı.
 */
@Injectable()
export class MatchingService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repository: MatchingRepository,
    private readonly bookings: BookingsService,
    private readonly bookingState: BookingStateService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly config: AppConfigService,
    @Inject(MATCHING_CLIENT) private readonly engine: MatchingClient,
  ) {}

  /** Tek talebi eşleştirir. */
  async matchRequest(input: { requestId: string; actorUserId: string }): Promise<MatchOutcome> {
    const outcomes = await this.match([input.requestId], input.actorUserId);
    const outcome = outcomes[0];
    if (outcome === undefined) {
      throw new BusinessException(ErrorCode.NOT_FOUND);
    }
    return outcome;
  }

  /**
   * Birden fazla talebi **birlikte** eşleştirir.
   *
   * Toplu çalıştırma ayrı bir özellik değil, asıl olandır: kapasite ve seyahat
   * kısıtları nedeniyle bir talebin en iyi sağlayıcısı başka bir talebe gidebilir.
   * Tek talep de aynı yoldan geçer; ayrı bir kod yolu açmak iki yolun zamanla
   * ayrışması demek olurdu.
   */
  async match(requestIds: string[], actorUserId: string): Promise<MatchOutcome[]> {
    if (requestIds.length > this.config.env.MATCHING_BATCH_LIMIT) {
      throw new BusinessException(ErrorCode.VALIDATION_FAILED, {
        clientMessage: 'Tek seferde eşleştirilebilecek talep sayısı aşıldı.',
        details: { limit: this.config.env.MATCHING_BATCH_LIMIT },
      });
    }

    const ordered = [...new Set(requestIds)].sort();

    // --- 1. Okuma: talepleri doğrula ve aday havuzunu getir ---
    //
    // Kısa ömürlü bir transaction. Talepler **sıralı** kilitlenir: farklı isteklerin
    // aynı talep kümesini farklı sırayla kilitlemesi deadlock üretirdi.
    const prepared = await this.uow.withTransaction(async (client) => {
      const items: PreparedDemand[] = [];
      for (const requestId of ordered) {
        items.push(await this.prepare(client, requestId));
      }
      return items;
    });

    // --- 2. Karar: motor çağrısı, **transaction dışında** ---
    //
    // Bu çağrı 10 saniyeye kadar sürebilir. Transaction içinde yapılsaydı, o süre
    // boyunca hem bir havuz bağlantısı hem de talep satırlarının kilidi tutulurdu:
    // yavaşlayan bir AI servisi, havuzu (varsayılan 10 bağlantı) tüketip **ilgisiz
    // tüm endpoint'leri** durdururdu. Bağlantı tutmadan beklemek, bekleme süresini
    // sistemin geri kalanından yalıtır.
    //
    // Bedeli: aday verisi yazma anında bayattır. Bu yüzden 3. adım kritik alanları
    // (durum, kapasite, müsaitlik) **yeniden okur** — ayrıntı için oradaki nota bakın.
    const decisionStarted = Date.now();
    const solution = await this.decide(prepared);
    const decisionMs = Date.now() - decisionStarted;

    // --- 3. Yazma: yeniden doğrula ve kaydet ---
    return this.uow.withTransaction(async (client) => {
      const outcomes: MatchOutcome[] = [];

      // Kapasite ve takvim, **parti boyunca** birikir. Her talebi bağımsız
      // doğrulamak, aynı sağlayıcıya günlük sınırının üstünde iş vermeyi mümkün
      // kılardı: her kontrol aynı bayat `dailyBookingCount` anlık görüntüsünü görür
      // ve hiçbiri diğerinin atamasını bilmezdi.
      const batch: BatchState = { capacity: new Map(), scheduled: new Map() };

      for (const item of prepared) {
        outcomes.push(
          await this.persist(client, {
            prepared: item,
            solution,
            decisionMs,
            actorUserId,
            batch,
          }),
        );
      }

      return outcomes;
    });
  }

  /**
   * Talebi kilitler, doğrular ve aday havuzunu getirir.
   *
   * Kilit bu (kısa) okuma transaction'ı boyunca tutulur. Eşzamanlı ikinci bir
   * eşleştirme isteği burada değil, yazma adımında yakalanır: orada durum yeniden
   * okunur ve `MATCHED` görülürse istek reddedilir.
   */
  private async prepare(client: PoolClient, requestId: string): Promise<PreparedDemand> {
    const context = await this.repository.lockRequestContext(client, requestId);
    if (context === null) {
      throw new BusinessException(ErrorCode.NOT_FOUND);
    }

    if (context.status === 'MATCHED') {
      throw new BusinessException(ErrorCode.MATCHING_ALREADY_COMPLETED);
    }
    if (!MATCHABLE_STATUSES.has(context.status)) {
      throw new BusinessException(ErrorCode.MATCHING_REQUEST_NOT_MATCHABLE, {
        details: { status: context.status },
      });
    }
    if (context.parserConfidence !== null && context.parserConfidence < MIN_MATCHING_CONFIDENCE) {
      throw new BusinessException(ErrorCode.MATCHING_CONFIDENCE_TOO_LOW, {
        details: { confidence: context.parserConfidence },
      });
    }

    const skills = await this.resolveSkills(client, context);

    const day = this.localDayBounds(context.preferredStart);
    const retrievalStarted = Date.now();
    const candidates = await this.repository.findCandidates(client, {
      context,
      dayStart: day.start,
      dayEnd: day.end,
      maxDistanceMeters: this.config.env.MATCHING_MAX_DISTANCE_METERS,
      limit: this.config.env.MATCHING_CANDIDATE_LIMIT,
    });
    const retrievalMs = Date.now() - retrievalStarted;

    return {
      context,
      retrievalMs,
      demand: {
        requestId: context.requestId,
        serviceSlug: context.serviceSlug,
        durationMinutes: context.durationMinutes,
        window: { start: context.preferredStart, end: context.preferredEnd },
        location: { latitude: context.latitude, longitude: context.longitude },
        requiredSkills: skills.required,
        preferredSkills: skills.preferred,
        candidates,
      },
    };
  }

  /**
   * Yetkinlik slug'larını katalogla karşılaştırır.
   *
   * İki küme **farklı** işlem görür ve bu ayrım bilinçlidir:
   *
   * - **Zorunlu** yetkinlikte bilinmeyen bir slug hatadır. Sessizce düşürmek hard
   *   constraint'i gevşetir ve müşteri talep etmediği bir sağlayıcıyla eşleşirdi.
   * - **Tercih** edilen yetkinlikte bilinmeyen slug **düşürülür**. Hata vermek
   *   yanlış olurdu: tercihler müşteri profilinden (`customer_profiles.preferences`)
   *   gelir ve serbest biçimli bir JSONB'dir; kullanıcı oraya ne yazarsa yazsın
   *   eşleştirme çalışmaya devam etmeli.
   *
   * Tercihleri **de** doğrulamak zorunlu: karar motorunun şeması kapalı bir slug
   * kümesi bekler ve tanımadığı bir değerde tüm isteği 422 ile reddeder. Doğrulama
   * olmasaydı, profiline uydurma bir slug yazan tek bir müşteri kendi eşleştirmesini
   * — ve toplu çalıştırmada **aynı partideki diğer müşterilerin** eşleştirmesini —
   * kalıcı olarak bozulmuş moda düşürürdü.
   */
  private async resolveSkills(
    client: PoolClient,
    context: MatchingRequestContext,
  ): Promise<{ required: string[]; preferred: string[] }> {
    const candidates = [...new Set([...context.requiredSkills, ...context.preferredSkills])];
    if (candidates.length === 0) {
      return { required: [], preferred: [] };
    }

    const known = await client.query<{ slug: string }>(
      `SELECT slug FROM skills WHERE slug = ANY($1::text[])`,
      [candidates],
    );
    const found = new Set(known.rows.map((row) => row.slug));

    const unknownRequired = context.requiredSkills.filter((slug) => !found.has(slug));
    if (unknownRequired.length > 0) {
      throw new BusinessException(ErrorCode.VALIDATION_FAILED, {
        clientMessage: 'Talepte tanınmayan bir yetkinlik var.',
        details: { unknownSkills: unknownRequired },
      });
    }

    return {
      required: context.requiredSkills,
      preferred: context.preferredSkills.filter((slug) => found.has(slug)),
    };
  }

  /** Motoru çağırır; kullanılabilir sonuç gelmezse core'un yedek sıralamasını üretir. */
  private async decide(prepared: PreparedDemand[]): Promise<Decision> {
    const outcome = await this.engine.solve({
      demands: prepared.map((item) => item.demand),
      optimize: true,
    });

    if (outcome.status === 'SOLVED') {
      return {
        source: 'ENGINE',
        algorithmVersion: outcome.solution.algorithmVersion,
        weightsVersion: outcome.solution.weightsVersion,
        objectiveVersion: outcome.solution.objectiveVersion,
        strategy: outcome.solution.strategy,
        degradedReason: outcome.solution.degradedReason,
        routingProvider: outcome.solution.routingProvider,
        optimizationRuntimeMs: outcome.solution.optimizationRuntimeMs,
        rankings: new Map(
          outcome.solution.rankings.map((ranking) => [ranking.requestId, ranking.candidates]),
        ),
        assignments: new Map(
          outcome.solution.assignments.map((assignment) => [assignment.requestId, assignment]),
        ),
      };
    }

    // Motor yok: deterministik yedek. Sonuç `ENGINE_UNAVAILABLE` ile işaretlenir ve
    // ayrı bir `algorithm_version` ile saklanır — Ar-Ge sorgularında motor
    // kararlarıyla karışmaz.
    const maxDistanceMeters = this.config.env.MATCHING_MAX_DISTANCE_METERS;
    const rankings = new Map<string, MatchingRankedCandidate[]>();
    const assignments = new Map<string, MatchingAssignment>();

    // Kapasite toplu çalıştırmada **paylaşılır**: yedek yol da aynı sağlayıcıya
    // günlük sınırının üstünde iş veremez.
    const usedCapacity = new Map<string, number>();
    const scheduled = new Map<string, { start: Date; end: Date }[]>();

    for (const item of [...prepared].sort((first, second) =>
      first.demand.window.start.getTime() === second.demand.window.start.getTime()
        ? first.demand.requestId.localeCompare(second.demand.requestId)
        : first.demand.window.start.getTime() - second.demand.window.start.getTime(),
    )) {
      const ranking = fallbackRanking(item.demand, { maxDistanceMeters });
      rankings.set(item.demand.requestId, ranking.eligible);

      const placed = this.placeGreedily(item, ranking.eligible, usedCapacity, scheduled);
      if (placed !== null) {
        assignments.set(item.demand.requestId, placed);
      }
    }

    return {
      source: 'FALLBACK',
      algorithmVersion: FALLBACK_ALGORITHM_VERSION,
      weightsVersion: FALLBACK_WEIGHTS_VERSION,
      objectiveVersion: FALLBACK_OBJECTIVE_VERSION,
      strategy: 'RANKED_FALLBACK',
      // Sözleşme uyuşmazlığı ayrı etiketlenir: kesinti gibi kaydedilseydi,
      // "AI servisi ne sıklıkla düşüyor" grafiği aslında bir şema hatasını
      // gösterirdi ve kimse doğru yere bakmazdı.
      degradedReason:
        outcome.reason === 'CONTRACT_MISMATCH' ? 'ENGINE_CONTRACT_MISMATCH' : 'ENGINE_UNAVAILABLE',
      routingProvider: 'none',
      optimizationRuntimeMs: null,
      rankings,
      assignments,
    };
  }

  /**
   * Yedek yolun takvim yerleştirmesi.
   *
   * En erken uygun başlangıcı seçer; kapasite ve aynı çalıştırmada verilmiş
   * randevularla çakışma kontrol edilir. Yol süresi hesaba katılmaz — rota servisi
   * bu modda kullanılmıyor — bu yüzden randevular arasına hizmetin kendisi dışında
   * boşluk konmaz ve bu bilinçli bir sınırlamadır: yedek yol iyi değil, **geçerli**
   * bir sonuç üretmek içindir.
   */
  private placeGreedily(
    item: PreparedDemand,
    ranked: MatchingRankedCandidate[],
    usedCapacity: Map<string, number>,
    scheduled: Map<string, { start: Date; end: Date }[]>,
  ): MatchingAssignment | null {
    const byId = new Map(
      item.demand.candidates.map((candidate) => [candidate.providerId, candidate]),
    );
    const day = this.localDayBounds(item.demand.window.start).start.toISOString();

    for (const entry of ranked) {
      const candidate = byId.get(entry.providerId);
      if (candidate === undefined) {
        continue;
      }

      const capacityKey = `${entry.providerId}:${day}`;
      const used = usedCapacity.get(capacityKey) ?? 0;
      if (candidate.dailyBookingCount + used >= candidate.maxDailyBookings) {
        continue;
      }

      const start = this.earliestStart(
        item.demand,
        candidate,
        scheduled.get(entry.providerId) ?? [],
      );
      if (start === null) {
        continue;
      }

      const end = new Date(start.getTime() + item.demand.durationMinutes * 60_000);
      usedCapacity.set(capacityKey, used + 1);
      scheduled.set(entry.providerId, [...(scheduled.get(entry.providerId) ?? []), { start, end }]);

      return {
        requestId: item.demand.requestId,
        providerId: entry.providerId,
        scheduledStart: start,
        scheduledEnd: end,
        travelSeconds: entry.travelSeconds,
        distanceMeters: entry.distanceMeters,
        rank: entry.rank,
      };
    }

    return null;
  }

  private earliestStart(
    demand: MatchingDemand,
    candidate: MatchingCandidate,
    busy: { start: Date; end: Date }[],
  ): Date | null {
    const durationMs = demand.durationMinutes * 60_000;
    const ordered = [...busy].sort(
      (first, second) => first.start.getTime() - second.start.getTime(),
    );

    for (const window of candidate.availability) {
      const windowStart = Math.max(window.start.getTime(), demand.window.start.getTime());
      const windowEnd = Math.min(window.end.getTime(), demand.window.end.getTime());
      let start = windowStart;

      for (const block of ordered) {
        if (start + durationMs <= block.start.getTime()) {
          break;
        }
        if (start < block.end.getTime()) {
          start = block.end.getTime();
        }
      }

      if (start + durationMs <= windowEnd) {
        return new Date(start);
      }
    }

    return null;
  }

  /** Kararı doğrular, rezervasyonu oluşturur ve karar kaydını yazar. */
  private async persist(
    client: PoolClient,
    input: {
      prepared: PreparedDemand;
      solution: Decision;
      decisionMs: number;
      actorUserId: string;
      batch: BatchState;
    },
  ): Promise<MatchOutcome> {
    const { prepared, solution } = input;
    const demand = prepared.demand;
    const ranked = solution.rankings.get(demand.requestId) ?? [];
    const maxDistanceMeters = this.config.env.MATCHING_MAX_DISTANCE_METERS;

    // Motorun sıraladığı adaylar core'un kendi kısıt değerlendirmesinden geçirilir.
    // Geçmeyen aday **saklanmaz da**: `booking_match_results` bir karar kaydıdır ve
    // ihlalli bir adayı sıralamada göstermek, o adayın değerlendirilebilir olduğu
    // izlenimi yaratırdı.
    const byId = new Map(demand.candidates.map((candidate) => [candidate.providerId, candidate]));
    const verified: MatchingRankedCandidate[] = [];
    // Motor aynı sağlayıcıyı iki kez döndürürse `UNIQUE (run_id, provider_id)`
    // tüm transaction'ı düşürür ve müşteri 500 alır. Veritabanı doğru davranır ama
    // sonuç kötüdür: core motora güvenmiyorsa tekrarı da kendisi elemeli.
    const seen = new Set<string>();
    let violations = 0;

    for (const entry of ranked) {
      const candidate = byId.get(entry.providerId);
      if (
        candidate === undefined ||
        seen.has(entry.providerId) ||
        evaluateConstraints(demand, candidate, { maxDistanceMeters }).length > 0
      ) {
        violations += 1;
        continue;
      }
      seen.add(entry.providerId);
      verified.push({ ...entry, rank: verified.length + 1 });
    }

    // Talep, karar verilirken hâlâ eşleştirilebilir durumdaydı; motor çağrısı
    // transaction dışında yapıldığı için **şimdi** yeniden kontrol edilir.
    // Eşzamanlı ikinci bir istek arada eşleştirmiş olabilir.
    const currentStatus = await this.repository.lockRequestStatus(client, demand.requestId);
    if (currentStatus === 'MATCHED') {
      throw new BusinessException(ErrorCode.MATCHING_ALREADY_COMPLETED);
    }

    const proposed = this.verifyAssignment(
      demand,
      byId,
      verified,
      solution.assignments.get(demand.requestId),
    );

    const assignment =
      proposed === null
        ? null
        : await this.acceptAssignment(client, {
            prepared,
            assignment: proposed,
            batch: input.batch,
          });

    if (solution.assignments.has(demand.requestId) && assignment === null) {
      violations += 1;
    }

    let bookingId: string | null = null;
    if (assignment !== null) {
      const booking = await this.bookings.createWithin(client, {
        requestId: demand.requestId,
        customerId: prepared.context.customerId,
        providerId: assignment.providerId,
        serviceId: prepared.context.serviceId,
        addressId: prepared.context.addressId,
        scheduledStart: assignment.scheduledStart,
        scheduledEnd: assignment.scheduledEnd,
      });
      bookingId = booking.id;

      // Durum makinesi atlanmaz: eşleştirme de `SYSTEM` aktörüyle aynı geçiş
      // tablosundan geçer (ADR-0006). Ayrı bir "içeriden güncelleme" yolu açmak,
      // transition map'i atlatılabilir kılardı.
      await this.bookingState.transition(client, {
        bookingId: booking.id,
        to: 'MATCHED',
        actor: 'SYSTEM',
        reason: solution.algorithmVersion,
      });
      await this.bookingState.transition(client, {
        bookingId: booking.id,
        to: 'PROVIDER_PENDING',
        actor: 'SYSTEM',
      });

      await this.repository.setRequestStatus(client, demand.requestId, 'MATCHED');
    }

    const runId = await this.repository.insertRun(client, {
      requestId: demand.requestId,
      algorithmVersion: solution.algorithmVersion,
      weightsVersion: solution.weightsVersion,
      objectiveVersion: solution.objectiveVersion,
      strategy: solution.strategy,
      degradedReason: solution.degradedReason,
      routingProvider: solution.routingProvider,
      candidateCount: demand.candidates.length,
      eligibleCount: verified.length,
      constraintViolations: violations,
      retrievalMs: prepared.retrievalMs,
      decisionMs: input.decisionMs,
      optimizationRuntimeMs: solution.optimizationRuntimeMs,
    });

    await this.repository.insertResults(client, {
      runId,
      requestId: demand.requestId,
      algorithmVersion: solution.algorithmVersion,
      candidates: verified,
      selectedProviderId: assignment?.providerId ?? null,
      selectedStart: assignment?.scheduledStart ?? null,
      selectedEnd: assignment?.scheduledEnd ?? null,
    });

    await this.audit.record(client, {
      action: AuditAction.MATCHING_RUN_COMPLETED,
      entityType: 'matching_run',
      entityId: runId,
      actorUserId: input.actorUserId,
      // Skorlar ve sağlayıcı kimliği audit'e yazılmaz: karar kaydı zaten
      // `booking_match_results`'tadır ve audit kişisel/karar detayı taşımaz (ADR-0013 §10).
      newValue: {
        requestId: demand.requestId,
        strategy: solution.strategy,
        algorithmVersion: solution.algorithmVersion,
        candidateCount: demand.candidates.length,
        eligibleCount: verified.length,
        assigned: assignment !== null,
      },
    });

    if (assignment !== null && bookingId !== null) {
      await this.audit.record(client, {
        action: AuditAction.BOOKING_MATCHED,
        entityType: 'booking',
        entityId: bookingId,
        actorUserId: input.actorUserId,
        newValue: { runId, algorithmVersion: solution.algorithmVersion },
      });

      await this.outbox.enqueue(client, {
        eventType: EventType.BOOKING_MATCHED,
        subjectType: 'booking',
        subjectId: bookingId,
        // Skor bileşenleri ve aday listesi event'te taşınmaz; tüketici yetkisiyle okur.
        payload: {
          bookingId,
          requestId: demand.requestId,
          providerId: assignment.providerId,
          runId,
          algorithmVersion: solution.algorithmVersion,
        },
      });
    }

    const selected = verified.find((entry) => entry.providerId === assignment?.providerId);

    return {
      runId,
      requestId: demand.requestId,
      algorithmVersion: solution.algorithmVersion,
      weightsVersion: solution.weightsVersion,
      objectiveVersion: solution.objectiveVersion,
      strategy: solution.strategy,
      degradedReason: solution.degradedReason,
      candidateCount: demand.candidates.length,
      eligibleCount: verified.length,
      constraintViolations: violations,
      retrievalMs: prepared.retrievalMs,
      decisionMs: input.decisionMs,
      bookingId,
      selectedProviderId: assignment?.providerId ?? null,
      selectedProviderName:
        assignment === null
          ? null
          : await this.repository.findProviderDisplayName(assignment.providerId),
      scheduledStart: assignment?.scheduledStart ?? null,
      scheduledEnd: assignment?.scheduledEnd ?? null,
      explanation: selected?.explanation ?? [],
    };
  }

  /**
   * Atamayı **taze veriye** ve parti durumuna karşı kabul eder.
   *
   * Motor çağrısı transaction dışında yapıldığı için aday verisi bu noktada bayattır.
   * Üç kontrol tazelik açığını kapatır:
   *
   * 1. **Kapasite yeniden okunur** (`FOR SHARE` ile kilitlenerek): sağlayıcı arada
   *    başka bir rezervasyon almış olabilir.
   * 2. **Parti içi kapasite** sayılır: aynı çalıştırmada aynı sağlayıcıya verilen
   *    işler birbirini görmek zorunda.
   * 3. **Parti içi çakışma** kontrol edilir: EXCLUDE constraint bunu zaten yakalar
   *    ama transaction'ın tamamını düşürerek. Önceden elemek, tek bir atamayı
   *    düşürüp diğerlerini kurtarır ve sayaca doğru değeri yazar.
   *
   * Müsaitlik ayrıca `createWithin` içinde kilit altında yeniden kontrol edilir.
   */
  private async acceptAssignment(
    client: PoolClient,
    input: {
      prepared: PreparedDemand;
      assignment: MatchingAssignment;
      batch: BatchState;
    },
  ): Promise<MatchingAssignment | null> {
    const { assignment, batch } = input;
    const day = this.localDayBounds(input.prepared.demand.window.start);
    const capacityKey = `${assignment.providerId}:${day.start.toISOString()}`;

    const capacity = await this.repository.readCapacity(client, {
      providerId: assignment.providerId,
      dayStart: day.start,
      dayEnd: day.end,
    });
    if (capacity === null) {
      return null;
    }

    const usedInBatch = batch.capacity.get(capacityKey) ?? 0;
    if (capacity.dailyBookingCount + usedInBatch >= capacity.maxDailyBookings) {
      return null;
    }

    const scheduled = batch.scheduled.get(assignment.providerId) ?? [];
    const overlaps = scheduled.some(
      (slot) =>
        assignment.scheduledStart.getTime() < slot.end.getTime() &&
        slot.start.getTime() < assignment.scheduledEnd.getTime(),
    );
    if (overlaps) {
      return null;
    }

    batch.capacity.set(capacityKey, usedInBatch + 1);
    batch.scheduled.set(assignment.providerId, [
      ...scheduled,
      { start: assignment.scheduledStart, end: assignment.scheduledEnd },
    ]);

    return assignment;
  }

  /**
   * Atamanın core tarafından kabul edilebilir olup olmadığı.
   *
   * Üç koşul birden aranır: sağlayıcı doğrulanmış sıralamada olmalı, kısıtları
   * sağlamalı ve önerilen takvim gerçekten müsait bir aralığın içinde olmalı.
   * Herhangi biri tutmazsa atama **düşer** — motor ne derse desin.
   */
  private verifyAssignment(
    demand: MatchingDemand,
    byId: Map<string, MatchingCandidate>,
    verified: MatchingRankedCandidate[],
    assignment: MatchingAssignment | undefined,
  ): MatchingAssignment | null {
    if (assignment === undefined) {
      return null;
    }
    if (!verified.some((entry) => entry.providerId === assignment.providerId)) {
      return null;
    }

    const candidate = byId.get(assignment.providerId);
    if (candidate === undefined) {
      return null;
    }
    if (
      !scheduleIsFeasible(demand, candidate, {
        start: assignment.scheduledStart,
        end: assignment.scheduledEnd,
      })
    ) {
      return null;
    }

    return assignment;
  }

  /**
   * Talebin **yerel** gününün sınırları.
   *
   * Kapasite "günlük"tür ve gün, müşterinin yaşadığı zaman dilimindeki gündür.
   * UTC günü kullanmak, yerel gece yarısı ile UTC gece yarısı arasındaki üç saatte
   * kapasiteyi yanlış güne yazardı.
   */
  private localDayBounds(moment: Date): { start: Date; end: Date } {
    const offset = this.config.env.SERVICE_TIMEZONE_OFFSET;
    const sign = offset.startsWith('-') ? -1 : 1;
    const offsetMs =
      sign * (Number(offset.slice(1, 3)) * 3_600_000 + Number(offset.slice(4, 6)) * 60_000);

    const local = new Date(moment.getTime() + offsetMs);
    const localMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());

    const start = new Date(localMidnight - offsetMs);
    return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
  }
}

interface Decision {
  source: 'ENGINE' | 'FALLBACK';
  algorithmVersion: string;
  weightsVersion: string;
  objectiveVersion: string;
  strategy: MatchingStrategy;
  degradedReason: MatchingDegradedReason | null;
  routingProvider: string;
  optimizationRuntimeMs: number | null;
  rankings: Map<string, MatchingRankedCandidate[]>;
  assignments: Map<string, MatchingAssignment>;
}
