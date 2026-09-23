import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { UnitOfWork } from '../common/database/unit-of-work';
import type {
  MatchingCandidate,
  MatchingRankedCandidate,
  MatchingSkillLevel,
} from './matching.port';

export interface MatchingRequestContext {
  requestId: string;
  customerId: string;
  serviceId: string;
  serviceSlug: string;
  addressId: string;
  latitude: number;
  longitude: number;
  preferredStart: Date;
  preferredEnd: Date;
  durationMinutes: number;
  status: string;
  /** Serbest metin yolunda ayrıştırma güveni; form yolunda null. */
  parserConfidence: number | null;
  /** NLP'nin çıkardığı zorunlu yetkinlikler; form yolunda boştur. */
  requiredSkills: string[];
  /** Müşteri profilindeki tercihler — kapalı slug kümesine indirgenmiş hâlde. */
  preferredSkills: string[];
}

interface RequestRow {
  id: string;
  customer_id: string;
  service_id: string;
  service_slug: string;
  address_id: string;
  latitude: number;
  longitude: number;
  preferred_start: Date;
  preferred_end: Date;
  duration_minutes: number;
  status: string;
  parser_confidence: string | null;
  requirements: unknown;
  preferences: unknown;
}

interface CandidateRow {
  provider_id: string;
  distance_meters: number;
  home_lat: number | null;
  home_lon: number | null;
  verified: boolean;
  max_daily_bookings: number;
  rating_avg: string | null;
  rating_count: number;
  quality_score: string | null;
  daily_booking_count: string;
  completed_bookings: string;
  offers_service: boolean;
  within_service_area: boolean;
  skills: { slug: string; level: MatchingSkillLevel }[];
  availability: { start: string; end: string }[];
  has_booking_in_window: boolean;
}

/**
 * Aday havuzu getirme ve karar kaydı yazma.
 *
 * İki tasarım kararı belirleyici:
 *
 * 1. **Tek sorgu, N+1 yok.** Her sağlayıcı için ayrı müsaitlik/yetkinlik sorgusu
 *    atmak, 50 adaylık bir havuzda 150 gidiş-dönüş demekti. Yetkinlikler ve
 *    müsaitlik pencereleri aynı sorguda JSON olarak toplanır.
 * 2. **Filtreleme veri katmanında.** 10.000 sağlayıcıyı uygulamaya çekip mesafe
 *    hesaplamak yerine GIST indeksli `ST_Intersects` sorgusu çalışır (ADR-0003).
 *    Havuz, hizmeti sunan + bölgesi adresi kapsayan + mesafe sınırındaki en yakın
 *    N sağlayıcıyla sınırlıdır.
 */
@Injectable()
export class MatchingRepository {
  constructor(private readonly uow: UnitOfWork) {}

  /**
   * Talebin karar için gereken bağlamı.
   *
   * `FOR UPDATE` çağıranın seçimine bırakılmaz: eşleştirme talebin durumunu
   * değiştirir, bu yüzden satır kilitlenmeden okunamaz — iki eşzamanlı istek
   * aynı talebi iki kez eşleştirebilirdi (idempotency).
   */
  async lockRequestContext(
    client: PoolClient,
    requestId: string,
  ): Promise<MatchingRequestContext | null> {
    const locked = await client.query<{ id: string }>(
      `SELECT id FROM booking_requests WHERE id = $1 FOR UPDATE`,
      [requestId],
    );
    if (locked.rowCount === 0) {
      return null;
    }

    const rows = await client.query<RequestRow>(
      `SELECT r.id, r.customer_id, r.service_id, s.slug AS service_slug, r.address_id,
              a.latitude, a.longitude, r.preferred_start, r.preferred_end,
              r.duration_minutes, r.status::text AS status,
              r.parser_confidence::text AS parser_confidence,
              r.structured_request -> 'requirements' AS requirements,
              cp.preferences AS preferences
         FROM booking_requests r
         JOIN services s ON s.id = r.service_id
         JOIN addresses a ON a.id = r.address_id
         JOIN customer_profiles cp ON cp.user_id = r.customer_id
        WHERE r.id = $1`,
      [requestId],
    );

    const row = rows.rows[0];
    return row === undefined ? null : toContext(row);
  }

  /**
   * Aday havuzu.
   *
   * Müsaitlik pencereleri **istisnalar ve mevcut aktif rezervasyonlar düşülmüş**
   * hâlde döner. Çıkarma multirange farkıyla yapılır: "çakışan rezervasyonu olan
   * sağlayıcıyı tamamen ele" kuralı, sabah iki saatlik işi olan bir sağlayıcıyı
   * tüm gün için elerdi. Kalan boşluk hizmete yetmiyorsa aday zaten müsaitlik
   * kısıtından elenir.
   */
  async findCandidates(
    client: PoolClient,
    input: {
      context: MatchingRequestContext;
      dayStart: Date;
      dayEnd: Date;
      maxDistanceMeters: number;
      limit: number;
    },
  ): Promise<MatchingCandidate[]> {
    const rows = await client.query<CandidateRow>(CANDIDATE_SQL, [
      input.context.addressId,
      input.context.serviceId,
      input.context.preferredStart,
      input.context.preferredEnd,
      input.context.durationMinutes,
      input.dayStart,
      input.dayEnd,
      input.maxDistanceMeters,
      input.limit,
    ]);

    return rows.rows.map(toCandidate);
  }

  /**
   * Sağlayıcının **taze** kapasite durumu.
   *
   * Aday havuzu okunduktan sonra motor çağrılır ve arada zaman geçer; bu sürede
   * sağlayıcı başka bir rezervasyon almış olabilir. Yazma transaction'ında kapasite
   * yeniden okunmazsa, karar bayat bir sayaca dayanır.
   *
   * Satır `FOR SHARE` ile kilitlenir: kontrol ile rezervasyonun yazılması arasında
   * sağlayıcının kapasitesi düşürülememeli (TOCTOU).
   */
  async readCapacity(
    client: PoolClient,
    input: { providerId: string; dayStart: Date; dayEnd: Date },
  ): Promise<{ maxDailyBookings: number; dailyBookingCount: number } | null> {
    const rows = await client.query<{ max_daily_bookings: number; daily_count: string }>(
      `SELECT pp.max_daily_bookings,
              (SELECT count(*) FROM bookings b
                WHERE b.provider_id = pp.user_id
                  AND b.status <> 'CANCELLED'
                  AND b.scheduled_start >= $2::timestamptz
                  AND b.scheduled_start < $3::timestamptz)::text AS daily_count
         FROM provider_profiles pp
        WHERE pp.user_id = $1
        FOR SHARE OF pp`,
      [input.providerId, input.dayStart, input.dayEnd],
    );

    const row = rows.rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      maxDailyBookings: Number(row.max_daily_bookings),
      dailyBookingCount: Number(row.daily_count),
    };
  }

  /** Talebin durumunu kilitleyerek okur (yazma transaction'ında yeniden doğrulama). */
  async lockRequestStatus(client: PoolClient, requestId: string): Promise<string | null> {
    const rows = await client.query<{ status: string }>(
      `SELECT status::text AS status FROM booking_requests WHERE id = $1 FOR UPDATE`,
      [requestId],
    );
    return rows.rows[0]?.status ?? null;
  }

  /** Karar kaydını açar. Satır, kararın kendisiyle aynı transaction'da yazılır. */
  async insertRun(
    client: PoolClient,
    input: {
      requestId: string;
      algorithmVersion: string;
      weightsVersion: string;
      objectiveVersion: string;
      strategy: string;
      degradedReason: string | null;
      routingProvider: string;
      candidateCount: number;
      eligibleCount: number;
      constraintViolations: number;
      retrievalMs: number;
      decisionMs: number;
      optimizationRuntimeMs: number | null;
    },
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO matching_runs
         (request_id, algorithm_version, weights_version, objective_version, strategy,
          degraded_reason, routing_provider, candidate_count, eligible_count,
          constraint_violations, retrieval_ms, decision_ms, optimization_runtime_ms)
       VALUES ($1, $2, $3, $4, $5::matching_strategy, $6::matching_degraded_reason,
               $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        input.requestId,
        input.algorithmVersion,
        input.weightsVersion,
        input.objectiveVersion,
        input.strategy,
        input.degradedReason,
        input.routingProvider,
        input.candidateCount,
        input.eligibleCount,
        input.constraintViolations,
        input.retrievalMs,
        input.decisionMs,
        input.optimizationRuntimeMs,
      ],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('matching çalıştırması kaydedilemedi');
    }
    return row.id;
  }

  /**
   * Sıralanmış adayları tek `INSERT` ile yazar.
   *
   * Aday başına ayrı `INSERT`, 50 adaylık bir havuzda 50 gidiş-dönüş demek olurdu;
   * hepsi aynı transaction'da olduğu için tek ifadeye toplanır.
   */
  async insertResults(
    client: PoolClient,
    input: {
      runId: string;
      requestId: string;
      algorithmVersion: string;
      candidates: MatchingRankedCandidate[];
      selectedProviderId: string | null;
      selectedStart: Date | null;
      selectedEnd: Date | null;
    },
  ): Promise<void> {
    if (input.candidates.length === 0) {
      return;
    }

    const values: unknown[] = [];
    const tuples: string[] = [];

    for (const candidate of input.candidates) {
      const selected = candidate.providerId === input.selectedProviderId;
      const offset = values.length;
      values.push(
        input.runId,
        input.requestId,
        candidate.providerId,
        candidate.rank,
        candidate.components.skillScore,
        candidate.components.availabilityScore,
        candidate.components.qualityScore,
        candidate.components.distanceScore,
        candidate.components.ratingScore,
        candidate.components.preferenceScore,
        candidate.overallScore,
        input.algorithmVersion,
        selected,
        JSON.stringify(candidate.explanation),
        candidate.distanceMeters,
        candidate.travelSeconds,
        selected ? input.selectedStart : null,
        selected ? input.selectedEnd : null,
      );
      const placeholders = Array.from({ length: 18 }, (_, index) => `$${offset + index + 1}`);
      // 14. parametre açıklamadır ve JSONB'ye cast edilmek zorunda.
      placeholders[13] = `${placeholders[13] as string}::jsonb`;
      tuples.push(`(${placeholders.join(', ')})`);
    }

    // `tuples` yalnızca yukarıda
    // üretilen `$N` yer tutucularından oluşur (sabit 18'lik bloklar); aday verisi
    // `values` dizisiyle parametreli geçer.
    // nosemgrep: emek-no-string-interpolated-sql
    await client.query(
      `INSERT INTO booking_match_results
         (run_id, request_id, provider_id, rank,
          skill_score, availability_score, quality_score, distance_score,
          rating_score, preference_score, overall_score,
          algorithm_version, selected, explanation,
          distance_meters, travel_seconds, proposed_start, proposed_end)
       VALUES ${tuples.join(', ')}`,
      values,
    );
  }

  /** Talebin son çalıştırması ve sonuçları (sahiplik çağıranda kontrol edilir). */
  async findLatestRun(requestId: string): Promise<{
    runId: string;
    algorithmVersion: string;
    weightsVersion: string;
    objectiveVersion: string;
    strategy: string;
    degradedReason: string | null;
    candidateCount: number;
    eligibleCount: number;
    createdAt: Date;
  } | null> {
    const rows = await this.uow.query<{
      id: string;
      algorithm_version: string;
      weights_version: string;
      objective_version: string;
      strategy: string;
      degraded_reason: string | null;
      candidate_count: number;
      eligible_count: number;
      created_at: Date;
    }>(
      `SELECT id, algorithm_version, weights_version, objective_version, strategy::text AS strategy,
              degraded_reason::text AS degraded_reason, candidate_count, eligible_count, created_at
         FROM matching_runs
        WHERE request_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [requestId],
    );

    const row = rows[0];
    if (row === undefined) {
      return null;
    }

    return {
      runId: row.id,
      algorithmVersion: row.algorithm_version,
      weightsVersion: row.weights_version,
      objectiveVersion: row.objective_version,
      strategy: row.strategy,
      degradedReason: row.degraded_reason,
      candidateCount: Number(row.candidate_count),
      eligibleCount: Number(row.eligible_count),
      createdAt: row.created_at,
    };
  }

  /** Bir çalıştırmanın sonuç satırları, sıraya göre. */
  async findResults(runId: string): Promise<
    {
      providerId: string;
      rank: number;
      components: Record<string, number>;
      overallScore: number;
      selected: boolean;
      explanation: { code: string; value: number | null }[];
      distanceMeters: number;
      travelSeconds: number;
      proposedStart: Date | null;
      proposedEnd: Date | null;
    }[]
  > {
    const rows = await this.uow.query<{
      provider_id: string;
      rank: number;
      skill_score: string;
      availability_score: string;
      quality_score: string;
      distance_score: string;
      rating_score: string;
      preference_score: string;
      overall_score: string;
      selected: boolean;
      explanation: { code: string; value: number | null }[];
      distance_meters: number;
      travel_seconds: number;
      proposed_start: Date | null;
      proposed_end: Date | null;
    }>(
      `SELECT provider_id, rank, skill_score, availability_score, quality_score,
              distance_score, rating_score, preference_score, overall_score, selected,
              explanation, distance_meters, travel_seconds, proposed_start, proposed_end
         FROM booking_match_results
        WHERE run_id = $1
        ORDER BY rank`,
      [runId],
    );

    return rows.map((row) => ({
      providerId: row.provider_id,
      rank: Number(row.rank),
      components: {
        skillScore: Number(row.skill_score),
        availabilityScore: Number(row.availability_score),
        qualityScore: Number(row.quality_score),
        distanceScore: Number(row.distance_score),
        ratingScore: Number(row.rating_score),
        preferenceScore: Number(row.preference_score),
      },
      overallScore: Number(row.overall_score),
      selected: row.selected,
      explanation: Array.isArray(row.explanation) ? row.explanation : [],
      distanceMeters: Number(row.distance_meters),
      travelSeconds: Number(row.travel_seconds),
      proposedStart: row.proposed_start,
      proposedEnd: row.proposed_end,
    }));
  }

  /** Talep durumunu ilerletir (`CREATED/MATCHING → MATCHED` vb.). */
  async setRequestStatus(client: PoolClient, requestId: string, status: string): Promise<void> {
    await client.query(
      `UPDATE booking_requests SET status = $2::booking_request_status WHERE id = $1`,
      [requestId, status],
    );
  }

  /** Talepten oluşan rezervasyonun kimliği (varsa). */
  async findBookingIdForRequest(requestId: string): Promise<string | null> {
    const rows = await this.uow.query<{ id: string }>(
      `SELECT id FROM bookings WHERE request_id = $1 ORDER BY created_at LIMIT 1`,
      [requestId],
    );
    return rows[0]?.id ?? null;
  }

  /** Sağlayıcı adını yalnızca **seçilen** aday için okur (veri sızıntısını sınırlar). */
  async findProviderDisplayName(providerId: string, client?: PoolClient): Promise<string | null> {
    const rows = await this.uow.queryOn<{ display_name: string }>(
      client,
      `SELECT display_name FROM provider_profiles WHERE user_id = $1`,
      [providerId],
    );
    return rows[0]?.display_name ?? null;
  }

  /**
   * Eşleştirme analitiği özeti (admin, Faz 10).
   *
   * Ham skor bileşenleri burada **yoktur** — `GET matching/runs/:requestId` zaten
   * tekil çalıştırmanın tam ayrıntısını verir (T-19 gerekçesiyle yalnızca ADMIN'e
   * açık). Bu uç operasyonel bir özet sunar: kaç çalıştırma bozulmuş modda bitti,
   * hangi strateji ne sıklıkta kullanıldı.
   */
  async adminStats(since: Date): Promise<{
    totalRuns: number;
    degradedRuns: number;
    byStrategy: Array<{ strategy: string; count: number }>;
    byDegradedReason: Array<{ reason: string; count: number }>;
    avgCandidateCount: number;
    avgRetrievalMs: number;
    avgDecisionMs: number;
  }> {
    const [totals, byStrategy, byDegradedReason] = await Promise.all([
      this.uow.query<{
        total_runs: string;
        degraded_runs: string;
        avg_candidate_count: string | null;
        avg_retrieval_ms: string | null;
        avg_decision_ms: string | null;
      }>(
        `SELECT count(*)::text AS total_runs,
                count(*) FILTER (WHERE degraded_reason IS NOT NULL)::text AS degraded_runs,
                avg(candidate_count)::text AS avg_candidate_count,
                avg(retrieval_ms)::text AS avg_retrieval_ms,
                avg(decision_ms)::text AS avg_decision_ms
           FROM matching_runs
          WHERE created_at >= $1`,
        [since],
      ),
      this.uow.query<{ strategy: string; count: string }>(
        `SELECT strategy::text, count(*)::text AS count
           FROM matching_runs
          WHERE created_at >= $1
          GROUP BY strategy
          ORDER BY count(*) DESC`,
        [since],
      ),
      this.uow.query<{ reason: string; count: string }>(
        `SELECT degraded_reason::text AS reason, count(*)::text AS count
           FROM matching_runs
          WHERE created_at >= $1 AND degraded_reason IS NOT NULL
          GROUP BY degraded_reason
          ORDER BY count(*) DESC`,
        [since],
      ),
    ]);

    const totalsRow = totals[0];
    return {
      totalRuns: Number(totalsRow?.total_runs ?? 0),
      degradedRuns: Number(totalsRow?.degraded_runs ?? 0),
      byStrategy: byStrategy.map((row) => ({ strategy: row.strategy, count: Number(row.count) })),
      byDegradedReason: byDegradedReason.map((row) => ({
        reason: row.reason,
        count: Number(row.count),
      })),
      avgCandidateCount:
        totalsRow?.avg_candidate_count === null ? 0 : Number(totalsRow?.avg_candidate_count ?? 0),
      avgRetrievalMs:
        totalsRow?.avg_retrieval_ms === null ? 0 : Number(totalsRow?.avg_retrieval_ms ?? 0),
      avgDecisionMs:
        totalsRow?.avg_decision_ms === null ? 0 : Number(totalsRow?.avg_decision_ms ?? 0),
    };
  }
}

/**
 * Aday havuzu sorgusu.
 *
 * Erişim yolu bilinçlidir: `provider_service_areas` üzerindeki GIST indeksi
 * (`area && adres`) sürücü indekstir, ardından birincil anahtar taramaları gelir.
 * Sağlayıcı tablosunda sequential scan yoktur.
 *
 * Eleme sırası kritiktir: doğrulama, müsaitlik ve kapasite **LIMIT'ten önce**
 * uygulanır (bkz. `usable` CTE). Yetkinlik kontrolü kısıt katmanına bırakılır.
 *
 * Parametreler:
 * $1 adres, $2 hizmet, $3 pencere başı, $4 pencere sonu, $5 süre (dk),
 * $6 gün başı, $7 gün sonu, $8 azami mesafe (m), $9 aday üst sınırı.
 */
/**
 * Aday havuzu sorgusu.
 *
 * Dışa aktarılır ki performans profili (`scripts/perf-db-profile.ts`) **gerçek**
 * sorguyu ölçsün: kopyalanmış bir metin zamanla sürüklenir ve profil sessizce
 * yanlış sorguyu ölçmeye başlar.
 */
export const CANDIDATE_SQL = `
WITH target AS (
  SELECT location FROM addresses WHERE id = $1 AND archived_at IS NULL
),
win AS (
  SELECT tstzrange($3::timestamptz, $4::timestamptz, '[)') AS range
),
eligible AS (
  SELECT ps.provider_id
    FROM provider_services ps
   WHERE ps.service_id = $2
     AND ps.active
     AND EXISTS (
       SELECT 1
         FROM provider_service_areas psa, target t
        WHERE psa.provider_id = ps.provider_id
          AND psa.active
          AND ST_Intersects(psa.area, t.location)
     )
),
base AS (
  -- Referans noktası: adresi **kapsayan** bölgenin ağırlık merkezi.
  --
  -- Tüm bölgelerin birleşiminin merkezi alınsaydı, iki uzak bölgede çalışan bir
  -- sağlayıcının merkezi ikisinin de dışına düşerdi: adres bir poligonun tam
  -- içindeyken sağlayıcı "çok uzak" diye elenebilirdi. Kapsayan bölgenin merkezi
  -- en fazla o bölgenin yarıçapı kadar uzaktadır.
  --
  -- Birden fazla bölge kapsıyorsa en **küçük** olan seçilir (en özgül bilgi);
  -- eşitlikte kimlik sırası, sonucun deterministik kalması için.
  SELECT DISTINCT ON (e.provider_id)
         e.provider_id,
         ST_Centroid(psa.area::geometry)::geography AS home
    FROM eligible e
    JOIN provider_service_areas psa ON psa.provider_id = e.provider_id AND psa.active
    CROSS JOIN target t
   WHERE ST_Intersects(psa.area, t.location)
   ORDER BY e.provider_id, coalesce(psa.radius_meters, 2147483647), psa.id
),
measured AS (
  SELECT b.provider_id, b.home, ST_Distance(b.home, t.location)::int AS distance_meters
    FROM base b, target t
   WHERE ST_Distance(b.home, t.location) <= $8
),
free AS (
  -- Müsaitlik = beyan edilen pencereler − istisnalar − aktif rezervasyonlar,
  -- talep penceresiyle kesiştirilmiş hâlde. Multirange farkı, kısmi bloklanmış
  -- günü doğru modelleyen tek yoldur.
  SELECT m.provider_id, m.home, m.distance_meters,
         (
           coalesce(
             (SELECT range_agg(av.slot) FROM availability av
               WHERE av.provider_id = m.provider_id AND av.slot && w.range),
             '{}'::tstzmultirange)
           - coalesce(
             (SELECT range_agg(ex.slot) FROM availability_exceptions ex
               WHERE ex.provider_id = m.provider_id AND ex.slot && w.range),
             '{}'::tstzmultirange)
           - coalesce(
             (SELECT range_agg(bk.slot) FROM bookings bk
               WHERE bk.provider_id = m.provider_id AND bk.status <> 'CANCELLED'
                 AND bk.slot && w.range),
             '{}'::tstzmultirange)
         ) * tstzmultirange(w.range) AS slots
    FROM measured m, win w
),
usable AS (
  -- Eleme **LIMIT'ten önce** yapılır.
  --
  -- Aksi hâlde "en yakın 50" havuzu, doğrulanmamış ya da o gün hiç müsait olmayan
  -- sağlayıcılarla dolabilir ve 200 m ötedeki uygun sağlayıcı havuza hiç giremezdi:
  -- müşteri "uygun sağlayıcı yok" yanıtı alırken sistem 50 aday değerlendirdiğini
  -- raporlardı. Yetkinlik kontrolü bilinçli olarak burada **yapılmaz** — talebe göre
  -- değişir ve kısıt katmanının ölçülebilir kalması için oraya bırakılır.
  SELECT f.provider_id, f.home, f.distance_meters, f.slots,
         pp.max_daily_bookings, pp.rating_avg, pp.rating_count, pp.quality_score,
         (SELECT count(*) FROM bookings db
           WHERE db.provider_id = f.provider_id
             AND db.status <> 'CANCELLED'
             AND db.scheduled_start >= $6::timestamptz
             AND db.scheduled_start < $7::timestamptz) AS daily_booking_count
    FROM free f
    JOIN provider_profiles pp ON pp.user_id = f.provider_id
    LEFT JOIN identity_records ir ON ir.user_id = f.provider_id
   WHERE pp.state = 'APPROVED'
     AND ir.verification_status = 'VERIFIED'
     AND EXISTS (
       SELECT 1 FROM unnest(f.slots) AS r
        WHERE upper(r) - lower(r) >= make_interval(mins => $5::int)
     )
)
SELECT u.provider_id,
       u.distance_meters,
       ST_Y(u.home::geometry) AS home_lat,
       ST_X(u.home::geometry) AS home_lon,
       TRUE AS verified,
       u.max_daily_bookings,
       u.rating_avg::text AS rating_avg,
       u.rating_count,
       u.quality_score::text AS quality_score,
       TRUE AS offers_service,
       TRUE AS within_service_area,
       u.daily_booking_count::text AS daily_booking_count,
       (SELECT count(*) FROM bookings cb
         WHERE cb.provider_id = u.provider_id
           AND cb.status IN ('COMPLETED','SETTLED'))::text AS completed_bookings,
       (SELECT coalesce(
                 json_agg(json_build_object('slug', sk.slug, 'level', pk.level) ORDER BY sk.slug),
                 '[]'::json)
          FROM provider_skills pk
          JOIN skills sk ON sk.id = pk.skill_id
         WHERE pk.provider_id = u.provider_id AND pk.verified) AS skills,
       (SELECT coalesce(
                 json_agg(json_build_object('start', lower(r), 'end', upper(r)) ORDER BY lower(r)),
                 '[]'::json)
          FROM unnest(u.slots) AS r
         WHERE upper(r) - lower(r) >= make_interval(mins => $5::int)) AS availability,
       EXISTS (SELECT 1 FROM bookings xb, win w
                WHERE xb.provider_id = u.provider_id
                  AND xb.status <> 'CANCELLED'
                  AND xb.slot && w.range) AS has_booking_in_window
  FROM usable u
 WHERE u.daily_booking_count < u.max_daily_bookings
 ORDER BY u.distance_meters, u.provider_id
 LIMIT $9
`;

function toContext(row: RequestRow): MatchingRequestContext {
  return {
    requestId: row.id,
    customerId: row.customer_id,
    serviceId: row.service_id,
    serviceSlug: row.service_slug,
    addressId: row.address_id,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    preferredStart: row.preferred_start,
    preferredEnd: row.preferred_end,
    durationMinutes: Number(row.duration_minutes),
    status: row.status,
    parserConfidence: row.parser_confidence === null ? null : Number(row.parser_confidence),
    requiredSkills: toSlugList(row.requirements),
    preferredSkills: toSlugList(readPreferredSkills(row.preferences)),
  };
}

/**
 * Müşteri tercihlerinden yetkinlik listesini çıkarır.
 *
 * `customer_profiles.preferences` serbest bir JSONB'dir; buradan yalnızca bilinen
 * anahtar okunur ve değerler slug biçimine göre elenir. Serbest metin karar
 * zincirine giremez (ADR-0007 §2, Faz 6 review bulgusu M2).
 */
function readPreferredSkills(preferences: unknown): unknown {
  if (typeof preferences !== 'object' || preferences === null) {
    return [];
  }
  return (preferences as Record<string, unknown>).preferredSkills ?? [];
}

/** Slug biçimine uymayan her değer düşer: kapalı küme güvencesi biçimle başlar. */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function toSlugList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const slugs = value.filter(
    (item): item is string =>
      typeof item === 'string' && item.length <= 80 && SLUG_PATTERN.test(item),
  );

  // Tekrarlar kaldırılır: motor şeması tekrar eden yetkinliği reddeder.
  return [...new Set(slugs)];
}

function toCandidate(row: CandidateRow): MatchingCandidate {
  const skills = Array.isArray(row.skills) ? row.skills : [];
  const availability = (Array.isArray(row.availability) ? row.availability : []).map((window) => ({
    start: new Date(window.start),
    end: new Date(window.end),
  }));

  const skillLevels: Record<string, MatchingSkillLevel> = {};
  for (const skill of skills) {
    skillLevels[skill.slug] = skill.level;
  }

  return {
    providerId: row.provider_id,
    verified: row.verified === true,
    offersService: row.offers_service,
    verifiedSkills: skills.map((skill) => skill.slug),
    availability,
    // Çakışma bayrağı yalnızca "rezervasyon var **ve** geriye hizmete yetecek
    // boşluk kalmadı" durumunda anlamlıdır: müsaitlik zaten rezervasyonlar
    // düşülerek hesaplandığı için boş kalması elenme nedenini kesinleştirir.
    hasConflictingBooking: row.has_booking_in_window && availability.length === 0,
    withinServiceArea: row.within_service_area,
    distanceMeters: Number(row.distance_meters),
    dailyBookingCount: Number(row.daily_booking_count),
    maxDailyBookings: Number(row.max_daily_bookings),
    skillLevels,
    ratingAvg: row.rating_avg === null ? null : Number(row.rating_avg),
    ratingCount: Number(row.rating_count),
    qualityScore: row.quality_score === null ? null : Number(row.quality_score),
    completedBookings: Number(row.completed_bookings),
    homeLocation:
      row.home_lat === null || row.home_lon === null
        ? null
        : { latitude: Number(row.home_lat), longitude: Number(row.home_lon) },
  };
}
