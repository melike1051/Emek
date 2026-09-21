/**
 * Matching domaini (Faz 7 — ADR-0007, ADR-0012).
 *
 * Üç yeni yetenek gerekiyor ve üçü de şemada karşılık bulmak zorunda:
 *
 * 1. **Sağlayıcı hangi hizmeti sunuyor?** Faz 2'de yalnızca yetkinlik (`provider_skills`)
 *    vardı; "bu sağlayıcı taşınma temizliği yapıyor mu" sorusunun karşılığı yoktu ve
 *    aday havuzu istenen hizmete göre daraltılamıyordu.
 * 2. **Günlük kapasite.** Optimizasyonun kapasite kısıtı bir üst sınır olmadan
 *    anlamsızdır; sınır sağlayıcının beyanıdır ve profilde yaşar.
 * 3. **Karar kaydı.** ADR-0012 §1: skor bileşenleri, `algorithm_version` ve `selected`
 *    saklanmadan geriye dönük deney yapılamaz. Sürüm kolonları "nice to have" değil,
 *    Ar-Ge iddiasının kanıt altyapısıdır.
 *
 * Skor kolonları NUMERIC'tir, float değil: skorlar karşılaştırılan ve raporlanan
 * değerlerdir; ikili kayan nokta gösterimi aynı girdinin iki ortamda farklı
 * saklanmasına yol açardı.
 */

exports.up = (pgm) => {
  // --- 1. Sağlayıcı hizmet katalogu ---
  pgm.sql(`
    CREATE TABLE provider_services (
      provider_id UUID NOT NULL REFERENCES provider_profiles(user_id) ON DELETE CASCADE,
      service_id UUID NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (provider_id, service_id)
    );

    -- Aday havuzu "bu hizmeti sunan sağlayıcılar" ile başlar: erişim yolu hizmettendir.
    CREATE INDEX idx_provider_services_service ON provider_services (service_id)
      WHERE active;
  `);

  // --- 1b. Hizmet bölgesinin yarıçapı ---
  //
  // Bölgeler API'den **merkez + yarıçap** olarak alınır (serbest poligon değil):
  // kendini kesen bir poligon GIST sorgusunu sessizce yanlış sonuç verdirir ve
  // `ST_IsValid` CHECK'i isteği çalışma zamanında düşürür. Yarıçap, poligondan
  // geri hesaplanmak yerine saklanır — türetme, kullanıcının girdiği değeri
  // yaklaşık olarak geri verir ve düzenleme akışında sapma birikirdi.
  pgm.sql(`
    ALTER TABLE provider_service_areas
      ADD COLUMN radius_meters INTEGER,
      ADD CONSTRAINT provider_service_areas_radius_range
        CHECK (radius_meters IS NULL OR (radius_meters >= 500 AND radius_meters <= 100000));
  `);

  // Sağlayıcı başına bölge sayısı sınırlıdır.
  //
  // İki nedenle: (1) `distance_meters` bölgelerin ağırlık merkezinden hesaplanır ve
  // merkez sağlayıcının çizdiği geometriye bağlıdır — sınırsız sayıda küçük daire,
  // merkezi istenen yere taşıyıp mesafe skorunu satın almayı mümkün kılardı;
  // (2) her eşleştirme sorgusu adayın tüm bölgelerini ST_Collect ile topluyor,
  // sınırsız satır bölgedeki her müşterinin sorgusunu yavaşlatırdı.
  //
  // Sınır uygulamada değil veritabanında: uygulama kontrolü tek savunma olsaydı,
  // toplu içe aktarma gibi başka bir yol onu atlatırdı (ADR-0004 §2 ile aynı ilke).
  pgm.sql(`
    CREATE OR REPLACE FUNCTION provider_service_areas_limit() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, pg_temp
    AS $$
    DECLARE
      area_count INTEGER;
    BEGIN
      SELECT count(*) INTO area_count
        FROM public.provider_service_areas
       WHERE provider_id = NEW.provider_id;

      IF area_count >= 5 THEN
        RAISE EXCEPTION 'sağlayıcı başına en fazla 5 hizmet bölgesi olabilir'
          USING ERRCODE = 'check_violation';
      END IF;

      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER provider_service_areas_enforce_limit
      BEFORE INSERT ON provider_service_areas
      FOR EACH ROW EXECUTE FUNCTION provider_service_areas_limit();
  `);

  // --- 2. Günlük kapasite ---
  //
  // Varsayılan 2: sınırsız kapasite (NULL) "kapasite kısıtı yok" demek olurdu ve
  // optimizasyon aynı sağlayıcıya sınırsız iş yığabilirdi. Üst sınır 10: ev
  // hizmetlerinde günde 10'dan fazla randevu fiziksel olarak anlamlı değil ve
  // sınırsız bir değer kombinatoryal patlamaya kapı açar (R-16).
  pgm.sql(`
    ALTER TABLE provider_profiles
      ADD COLUMN max_daily_bookings SMALLINT NOT NULL DEFAULT 2,
      ADD CONSTRAINT provider_profiles_capacity_range
        CHECK (max_daily_bookings BETWEEN 1 AND 10);
  `);

  // Bir talepten **en fazla bir** aktif rezervasyon çıkar.
  //
  // Uygulama bunu zaten engelliyor (talep MATCHED olunca ikinci eşleştirme reddedilir)
  // ama invariant veritabanında olmalı (CLAUDE.md §4): eşzamanlı iki yol, tekrar eden
  // bir toplu istek ya da ileride eklenecek başka bir akış, tek talep için iki
  // rezervasyon üretebilirdi. İptal edilenler dışlanır — iptal sonrası yeniden
  // eşleştirme meşru bir akıştır.
  pgm.sql(`
    CREATE UNIQUE INDEX uq_bookings_active_request
      ON bookings (request_id)
      WHERE request_id IS NOT NULL AND status <> 'CANCELLED';
  `);

  // --- 3. Karar kaydı ---
  pgm.sql(`
    CREATE TYPE matching_strategy AS ENUM ('OPTIMIZED','RANKED_FALLBACK','RANKING_ONLY');
    CREATE TYPE matching_degraded_reason AS ENUM (
      'OPTIMIZATION_TIMEOUT',
      'OPTIMIZATION_INFEASIBLE',
      'OPTIMIZATION_ERROR',
      'ROUTING_UNAVAILABLE',
      -- AI servisine hiç ulaşılamadı: core kendi deterministik yedek sıralamasını kullandı.
      'ENGINE_UNAVAILABLE',
      -- AI servisi isteği **anlamadı** (4xx): iki servisin şeması ayrışmış.
      -- Kesintiden ayrı tutulur; biri işletme durumu, diğeri hata.
      'ENGINE_CONTRACT_MISMATCH'
    );
  `);

  pgm.sql(`
    CREATE TABLE matching_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      -- RESTRICT: karar kaydı talebin silinmesini **engeller**. CASCADE olsaydı
      -- tek bir talep silme işlemi, o talep için verilmiş tüm kararların kanıtını
      -- sessizce yok ederdi — append-only trigger'ı da anlamsız kılarak.
      request_id UUID NOT NULL REFERENCES booking_requests(id) ON DELETE RESTRICT,
      -- Sürümler zorunludur (ADR-0012 §1): sürümsüz bir karar karşılaştırılamaz.
      algorithm_version VARCHAR(64) NOT NULL,
      weights_version VARCHAR(64) NOT NULL,
      objective_version VARCHAR(64) NOT NULL,
      strategy matching_strategy NOT NULL,
      degraded_reason matching_degraded_reason,
      routing_provider VARCHAR(32) NOT NULL,
      -- Ölçüm kolonları: aday sayısı ve gecikme, benchmark dışında **üretimde** de
      -- izlenebilmeli; yoksa laboratuvar sonucu ile gerçek davranış ayrışır.
      candidate_count INTEGER NOT NULL,
      eligible_count INTEGER NOT NULL,
      constraint_violations INTEGER NOT NULL DEFAULT 0,
      retrieval_ms INTEGER NOT NULL,
      decision_ms INTEGER NOT NULL,
      optimization_runtime_ms INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

      CHECK (candidate_count >= 0),
      CHECK (eligible_count >= 0 AND eligible_count <= candidate_count),
      CHECK (constraint_violations >= 0),
      CHECK (retrieval_ms >= 0 AND decision_ms >= 0),
      CHECK (optimization_runtime_ms IS NULL OR optimization_runtime_ms >= 0),
      -- Bozulma nedeni yalnızca bozulmuş stratejilerde anlamlıdır; RANKING_ONLY
      -- ve OPTIMIZED da rota bozulmasıyla işaretlenebilir, bu yüzden tek yönlü kural:
      -- fallback stratejisi mutlaka bir neden taşır.
      CHECK (strategy <> 'RANKED_FALLBACK' OR degraded_reason IS NOT NULL)
    );

    CREATE INDEX idx_matching_runs_request ON matching_runs (request_id, created_at DESC);
    -- Ar-Ge sorgusu: "şu sürümün üretimdeki sonuçları" (ADR-0012 §3).
    CREATE INDEX idx_matching_runs_algorithm ON matching_runs (algorithm_version, created_at DESC);
  `);

  pgm.sql(`
    CREATE TABLE booking_match_results (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      -- matching_runs zaten silinemez (trigger); bu yüzden CASCADE pratikte hiç
      -- tetiklenmez ve yalnızca niyeti ifade eder.
      run_id UUID NOT NULL REFERENCES matching_runs(id) ON DELETE CASCADE,
      -- Talep kimliği çalıştırmadan türetilebilir ama burada da tutulur: "bu talebin
      -- tüm sonuçları" sorgusu en sık sorulan sorudur ve join'siz cevaplanmalı.
      request_id UUID NOT NULL REFERENCES booking_requests(id) ON DELETE RESTRICT,
      -- bookings.provider_id ile aynı gerekçe: sağlayıcı profili silinse de o
      -- sağlayıcıyla verilmiş kararların bağlamı kaybolmamalı.
      provider_id UUID NOT NULL REFERENCES provider_profiles(user_id) ON DELETE RESTRICT,
      rank INTEGER NOT NULL,

      -- ADR-0007 §5: bileşenler **ayrı ayrı** saklanır. Tek bir toplam skor,
      -- "neden bu sağlayıcı" sorusunu sonradan yanıtlanamaz kılar ve ağırlık
      -- deneylerini imkânsızlaştırır.
      skill_score NUMERIC(6,4) NOT NULL,
      availability_score NUMERIC(6,4) NOT NULL,
      quality_score NUMERIC(6,4) NOT NULL,
      distance_score NUMERIC(6,4) NOT NULL,
      rating_score NUMERIC(6,4) NOT NULL,
      preference_score NUMERIC(6,4) NOT NULL,
      overall_score NUMERIC(6,4) NOT NULL,

      algorithm_version VARCHAR(64) NOT NULL,
      selected BOOLEAN NOT NULL DEFAULT FALSE,
      -- Açıklama kapalı kod kümesidir, serbest metin değil (ADR-0007 §6).
      explanation JSONB NOT NULL DEFAULT '[]'::jsonb,
      distance_meters INTEGER NOT NULL,
      travel_seconds INTEGER NOT NULL,
      -- Optimizasyonun önerdiği takvim; seçilmeyen adaylarda boştur.
      proposed_start TIMESTAMPTZ,
      proposed_end TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

      CHECK (rank > 0),
      CHECK (skill_score BETWEEN 0 AND 1),
      CHECK (availability_score BETWEEN 0 AND 1),
      CHECK (quality_score BETWEEN 0 AND 1),
      CHECK (distance_score BETWEEN 0 AND 1),
      CHECK (rating_score BETWEEN 0 AND 1),
      CHECK (preference_score BETWEEN 0 AND 1),
      CHECK (overall_score BETWEEN 0 AND 1),
      CHECK (distance_meters >= 0 AND travel_seconds >= 0),
      CHECK (jsonb_typeof(explanation) = 'array'),
      -- Takvim ya tam ya hiç: yarım bir öneri, "ne zaman" sorusunu belirsiz bırakır.
      CHECK ((proposed_start IS NULL) = (proposed_end IS NULL)),
      CHECK (proposed_end IS NULL OR proposed_end > proposed_start),
      -- Seçilen aday bir takvim taşımak zorundadır: seçim, "kim" ve "ne zaman"ın
      -- birlikte kararıdır.
      CHECK (NOT selected OR proposed_start IS NOT NULL),

      CONSTRAINT booking_match_results_unique_provider UNIQUE (run_id, provider_id),
      CONSTRAINT booking_match_results_unique_rank UNIQUE (run_id, rank)
    );

    -- Bir çalıştırmada en fazla **bir** aday seçilir. Uygulama hatası iki satırı
    -- seçili yazarsa "hangi sağlayıcı atandı" sorusunun iki cevabı olurdu.
    CREATE UNIQUE INDEX uq_booking_match_results_selected
      ON booking_match_results (run_id) WHERE selected;

    CREATE INDEX idx_booking_match_results_request
      ON booking_match_results (request_id, rank);
    CREATE INDEX idx_booking_match_results_provider
      ON booking_match_results (provider_id, created_at DESC);
  `);

  // Karar kaydı değiştirilemez **ve silinemez** (ADR-0012): sonradan düzeltilebilen
  // ya da silinebilen bir deney kaydı kanıt değeri taşımaz. `selected` bayrağı da
  // dâhil hiçbir kolon güncellenmez; karar değişirse **yeni bir çalıştırma** yazılır.
  //
  // Silme koruması güncelleme koruması kadar önemlidir: `matching_runs.strategy` ve
  // `degraded_reason`, kararın bozulmuş modda verildiğinin kanıtıdır. Silinebilir
  // olsaydı "hangi kararlar bozulmuş modda verildi" sorusu geriye dönük
  // yanıtlanamazdı — ve uyuşmazlıkta savunulabilirlik kaybolurdu.
  //
  // İki katman: trigger (uygulama rolü dâhil herkesi durdurur) ve REVOKE
  // (`audit_logs` ile aynı desen — migration 20260920130000).
  pgm.sql(`
    CREATE OR REPLACE FUNCTION match_records_immutable() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, pg_temp
    AS $$
    BEGIN
      RAISE EXCEPTION '% append-only: % engellendi', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'restrict_violation';
    END;
    $$;

    CREATE TRIGGER booking_match_results_no_update
      BEFORE UPDATE OR DELETE ON booking_match_results
      FOR EACH ROW EXECUTE FUNCTION match_records_immutable();

    CREATE TRIGGER matching_runs_no_update
      BEFORE UPDATE OR DELETE ON matching_runs
      FOR EACH ROW EXECUTE FUNCTION match_records_immutable();

    REVOKE UPDATE, DELETE, TRUNCATE ON booking_match_results FROM PUBLIC;
    REVOKE UPDATE, DELETE, TRUNCATE ON matching_runs FROM PUBLIC;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS uq_bookings_active_request;

    DROP TRIGGER IF EXISTS matching_runs_no_update ON matching_runs;
    DROP TRIGGER IF EXISTS booking_match_results_no_update ON booking_match_results;
    DROP FUNCTION IF EXISTS match_records_immutable();
    DROP TABLE IF EXISTS booking_match_results;
    DROP TABLE IF EXISTS matching_runs;
    DROP TYPE IF EXISTS matching_degraded_reason;
    DROP TYPE IF EXISTS matching_strategy;

    ALTER TABLE provider_profiles
      DROP CONSTRAINT IF EXISTS provider_profiles_capacity_range,
      DROP COLUMN IF EXISTS max_daily_bookings;

    DROP TRIGGER IF EXISTS provider_service_areas_enforce_limit ON provider_service_areas;
    DROP FUNCTION IF EXISTS provider_service_areas_limit();

    ALTER TABLE provider_service_areas
      DROP CONSTRAINT IF EXISTS provider_service_areas_radius_range,
      DROP COLUMN IF EXISTS radius_meters;

    DROP TABLE IF EXISTS provider_services;
  `);
};
