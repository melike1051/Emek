/**
 * Safety domaini (Faz 8 — ADR-0008, ADR-0019).
 *
 * Tasarımın tek cümlelik özeti: **konum toplama hizmet oturumuna bağlıdır.**
 * 24 saat takip yoktur; oturum telemetri kabul eden bir durumda değilse konum
 * reddedilir. Bu, şemaya dört yerde gömülüdür ve uygulamanın insafına bırakılmaz:
 *
 * 1. `location_events.session_id` zorunludur — oturumsuz konum kaydı yazılamaz.
 * 2. Rezervasyon başına **aynı anda tek** açık oturum olabilir (kısmi unique index).
 * 3. Oturum durumu yalnızca ileri gider ve `CLOSED` terminaldir (trigger).
 * 4. Ham konumun bir son kullanma tarihi vardır (`retention_expires_at`); retention
 *    bir politika metni değil, bir silme işidir.
 *
 * Telemetri **güvenilmez istemci girdisidir** (ADR-0008 §7). Şemadaki karşılığı:
 * her örnek hem `captured_at` (istemci) hem `server_received_at` (sunucu) taşır,
 * sunucu zamanı yetkilidir; oturum başına monoton sıra numarası
 * `safety_sessions.last_sequence` üzerinde kilit altında karşılaştır-ve-yaz ile korunur.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE safety_session_status AS ENUM (
      'NOT_STARTED',
      'PRE_SERVICE',
      'ARRIVAL_MONITORING',
      'ACTIVE',
      'CLOSED'
    );

    CREATE TYPE safety_risk_level AS ENUM ('NORMAL','WARNING','HIGH_RISK','EMERGENCY');

    -- Bir güvenlik olayının kaynağı. ML ayrı tutulur: "kural mı dedi, model mi dedi,
    -- kullanıcı mı dedi, operatör mü dedi" sorusu uyuşmazlıkta ve ölçümde farklı
    -- ağırlık taşır (ADR-0008 §4).
    CREATE TYPE safety_event_source AS ENUM ('RULE','ML','USER','SYSTEM','OPERATOR');

    CREATE TYPE safety_event_type AS ENUM (
      'SESSION_STARTED',
      'ARRIVAL_MONITORING_STARTED',
      'SESSION_ACTIVATED',
      'GEOFENCE_ENTERED',
      'GEOFENCE_EXITED',
      'TELEMETRY_REJECTED',
      'TELEMETRY_REANCHORED',
      'RULE_TRIGGERED',
      'ANOMALY_FLAGGED',
      'RISK_ESCALATED',
      'RISK_DEESCALATED',
      'RISK_OVERRIDDEN',
      'PANIC_RAISED',
      'SESSION_CLOSED'
    );

    -- Geofence sonucu ikili değildir. "Yetersiz doğruluk" ile "dışarıda" aynı şey
    -- sayılsaydı, kapalı alandaki zayıf GPS sinyali sağlayıcıyı kaçmış gibi gösterirdi.
    CREATE TYPE geofence_state AS ENUM (
      'UNKNOWN',
      'INSIDE',
      'OUTSIDE',
      'BOUNDARY',
      'INSUFFICIENT_ACCURACY'
    );

    CREATE TYPE safety_closure_reason AS ENUM (
      'SERVICE_COMPLETED',
      'BOOKING_CANCELLED',
      'EXPIRED',
      'OPERATOR_CLOSED'
    );
  `);

  pgm.sql(`
    CREATE TABLE safety_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
      -- Taraflar denormalize edilir: her telemetri örneğinde sahiplik kontrolü için
      -- bookings'e join atmak, en sık çalışan yolu en pahalı yol yapardı.
      provider_id UUID NOT NULL REFERENCES provider_profiles(user_id) ON DELETE RESTRICT,
      customer_id UUID NOT NULL REFERENCES customer_profiles(user_id) ON DELETE RESTRICT,

      status safety_session_status NOT NULL DEFAULT 'PRE_SERVICE',
      risk_level safety_risk_level NOT NULL DEFAULT 'NORMAL',

      -- Hizmet noktası oturuma kopyalanır: adres sonradan arşivlenirse bile oturumun
      -- geofence merkezi değişmemeli (karar verildiği andaki gerçek korunur).
      -- Retention sonrasında hassasiyeti düşürülür (~1 km), silinmez: oturum
      -- özeti araştırma için anlamlı kalır ama bir haneyi göstermez.
      service_location GEOGRAPHY(Point, 4326) NOT NULL,
      -- Tek evrensel yarıçap yoktur. Oturum başına saklanır ki karar yeniden
      -- üretilebilsin (R-56).
      geofence_radius_meters INTEGER NOT NULL,
      geofence_accuracy_limit_meters INTEGER NOT NULL,
      geofence_debounce_samples SMALLINT NOT NULL,

      geofence_state geofence_state NOT NULL DEFAULT 'UNKNOWN',
      geofence_state_since TIMESTAMPTZ,
      -- Debounce durumu: jitter'ın tekrar tekrar olay üretmesini engeller.
      geofence_candidate_state geofence_state,
      geofence_candidate_count SMALLINT NOT NULL DEFAULT 0,
      -- Check-in anındaki kabul edilmiş geofence durumu: "sağlayıcı hizmet noktasında
      -- değilken check-in yaptı" tutarsızlığının kaydı (SAFETY-R10).
      activation_geofence_state geofence_state,

      -- Telemetri politikası oturumda saklanır: istemci onu okur, sunucu onunla doğrular.
      telemetry_interval_seconds SMALLINT NOT NULL,
      telemetry_max_skew_seconds SMALLINT NOT NULL,
      telemetry_max_age_seconds SMALLINT NOT NULL,

      -- Replay koruması: monoton sıra numarası (ADR-0008 §7).
      last_sequence BIGINT NOT NULL DEFAULT 0,
      last_telemetry_at TIMESTAMPTZ,
      last_captured_at TIMESTAMPTZ,
      last_distance_meters INTEGER,
      -- Son kabul edilen konum oturumda tutulur.
      --
      -- "İmkânsız sıçrama" kontrolü bir **önceki** noktayı gerektirir ve bu, her
      -- telemetri örneğinde çalışan en sıcak yoldur. Partition'lanmış
      -- location_events'e her örnekte sorgu atmak, en sık çalışan işlemi en pahalı
      -- işlem yapardı. Retention'da NULL'lanır.
      last_latitude DOUBLE PRECISION,
      last_longitude DOUBLE PRECISION,
      last_accuracy_meters REAL,
      -- Ardışık "imkânsız hız" retleri. Eşiği aşınca yeni nokta çapa kabul edilir:
      -- aksi hâlde tek bir hatalı çapa sonrasındaki **tüm** doğru örnekleri
      -- reddettirirdi (hatalı cihaz koordinatı senaryosu).
      consecutive_speed_rejections SMALLINT NOT NULL DEFAULT 0,

      telemetry_count INTEGER NOT NULL DEFAULT 0,
      rejected_count INTEGER NOT NULL DEFAULT 0,
      -- Bütünlük retleri (imkânsız hız, saat geri gitmesi, geleceğe tarihli örnek).
      -- Tekrar/replay burada sayılmaz: ağ yeniden denemesi olağandır.
      integrity_rejection_count INTEGER NOT NULL DEFAULT 0,
      mock_location_count INTEGER NOT NULL DEFAULT 0,

      -- Beklenen davranışın referansı; "gecikti mi" sorusu bunlara göre yanıtlanır.
      scheduled_start TIMESTAMPTZ NOT NULL,
      scheduled_end TIMESTAMPTZ NOT NULL,
      -- Varış izlemenin başladığı an: hiç telemetri gelmediyse boşluk buradan ölçülür.
      -- Eksik telemetri "normal" sayılmaz (ADR-0008 §2).
      monitoring_started_at TIMESTAMPTZ,
      activated_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ,
      closure_reason safety_closure_reason,

      -- Değerlendirme durumu. Tetiklenen kural kümesi ve anomali bayrağı saklanır ki
      -- olaylar yalnızca **değişimde** yazılsın: her değerlendirmede aynı olayı
      -- tekrar yazmak, operatör görünümünü gürültüyle doldururdu.
      next_evaluation_at TIMESTAMPTZ,
      last_evaluated_at TIMESTAMPTZ,
      active_rules TEXT[] NOT NULL DEFAULT '{}',
      anomaly_flagged BOOLEAN NOT NULL DEFAULT FALSE,

      -- Panik: **etkin** panik varken tekrar basış yan etki üretmez. Operatör acil
      -- durumu çözdükten sonra (yanlış alarm) yeni bir panik yeniden kabul edilir —
      -- aksi hâlde ilk yanlış alarm, aynı hizmetteki gerçek bir acil durumu
      -- sessizce yutardı. panic_count her kabul edilen panikte artar ve olayın
      -- tekillik anahtarıdır.
      panic_raised_at TIMESTAMPTZ,
      panic_count SMALLINT NOT NULL DEFAULT 0,
      emergency_resolved_at TIMESTAMPTZ,

      -- Ham konum kaydının saklanma sınırı (ADR-0008 §5). Oturumda tutulur ki
      -- panik/uyuşmazlık oturumları için uzatılabilsin.
      retention_expires_at TIMESTAMPTZ NOT NULL,
      location_purged_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

      CHECK (geofence_radius_meters BETWEEN 25 AND 5000),
      CHECK (geofence_accuracy_limit_meters BETWEEN 10 AND 2000),
      CHECK (geofence_debounce_samples BETWEEN 1 AND 10),
      CHECK (telemetry_interval_seconds BETWEEN 5 AND 600),
      CHECK (telemetry_max_skew_seconds BETWEEN 10 AND 900),
      CHECK (telemetry_max_age_seconds BETWEEN 60 AND 3600),
      CHECK (last_sequence >= 0),
      CHECK (telemetry_count >= 0 AND rejected_count >= 0
             AND integrity_rejection_count >= 0 AND mock_location_count >= 0),
      CHECK (consecutive_speed_rejections >= 0),
      CHECK (last_latitude IS NULL OR last_latitude BETWEEN -90 AND 90),
      CHECK (last_longitude IS NULL OR last_longitude BETWEEN -180 AND 180),
      CHECK ((last_latitude IS NULL) = (last_longitude IS NULL)),
      CHECK (last_accuracy_meters IS NULL OR last_accuracy_meters >= 0),
      CHECK (geofence_candidate_count >= 0),
      CHECK (scheduled_end > scheduled_start),
      CHECK (panic_count >= 0),
      CHECK ((panic_raised_at IS NULL) = (panic_count = 0)),
      CHECK (emergency_resolved_at IS NULL OR panic_raised_at IS NOT NULL),
      -- Kapanış üç alanın birlikte hareket etmesidir; biri eksikse durum belirsizdir.
      CONSTRAINT safety_sessions_closure_consistent
        CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL)
               AND (closed_at IS NOT NULL) = (closure_reason IS NOT NULL)),
      CONSTRAINT safety_sessions_activation_consistent
        CHECK (activated_at IS NULL OR status IN ('ACTIVE','CLOSED')),
      -- Retention yapılmış oturumda ham konum kalmaz.
      CONSTRAINT safety_sessions_purge_consistent
        CHECK (location_purged_at IS NULL OR (last_latitude IS NULL AND last_longitude IS NULL)),
      -- Kendi kendine hizmet yok (bookings_not_self ile aynı gerekçe).
      CONSTRAINT safety_sessions_not_self CHECK (provider_id <> customer_id)
    );

    -- Rezervasyon başına **aynı anda tek** açık oturum. Eşzamanlı iki istek iki oturum
    -- açabilseydi, telemetri ikiye bölünür ve hiçbir oturum tam resmi görmezdi.
    CREATE UNIQUE INDEX uq_safety_sessions_open_booking
      ON safety_sessions (booking_id) WHERE status <> 'CLOSED';

    CREATE INDEX idx_safety_sessions_booking ON safety_sessions (booking_id, created_at DESC);
    CREATE INDEX idx_safety_sessions_provider ON safety_sessions (provider_id, created_at DESC);
    CREATE INDEX idx_safety_sessions_customer ON safety_sessions (customer_id, created_at DESC);
    -- Operatör görünümü: açık ve riskli oturumlar.
    CREATE INDEX idx_safety_sessions_open_risk
      ON safety_sessions (risk_level, created_at DESC) WHERE status <> 'CLOSED';
    -- İzleyicinin tarama yolu: değerlendirmesi gelen, telemetri kabul eden oturumlar.
    CREATE INDEX idx_safety_sessions_due
      ON safety_sessions (next_evaluation_at)
      WHERE status IN ('ARRIVAL_MONITORING','ACTIVE');
    -- Retention job'ın tarama yolu: yalnızca henüz temizlenmemiş oturumlar.
    CREATE INDEX idx_safety_sessions_retention
      ON safety_sessions (retention_expires_at) WHERE location_purged_at IS NULL;

    CREATE TRIGGER safety_sessions_set_updated_at
      BEFORE UPDATE ON safety_sessions
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  // Oturum durumu yalnızca ileri gider; CLOSED terminaldir.
  //
  // Geçiş tablosunun tamamı uygulamadadır (safety-session.state.ts). Veritabanı
  // tablonun **kopyasını** tutmaz — iki kopya ayrışırdı (R-48 dersi) — ama ihlali
  // en pahalı iki invariant'ı garanti eder: kapanmış bir oturum yeniden açılıp
  // telemetri kabul etmeye başlayamaz ve oturum geriye gidemez.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION safety_session_status_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, public, pg_temp
    AS $$
    DECLARE
      ordinal_old INT := array_position(enum_range(NULL::safety_session_status), OLD.status);
      ordinal_new INT := array_position(enum_range(NULL::safety_session_status), NEW.status);
    BEGIN
      IF NEW.status IS DISTINCT FROM OLD.status AND ordinal_new < ordinal_old THEN
        RAISE EXCEPTION 'safety_sessions: % → % geçişi geri gider', OLD.status, NEW.status
          USING ERRCODE = 'check_violation',
                CONSTRAINT = 'safety_sessions_status_forward';
      END IF;
      IF OLD.status = 'CLOSED' AND (
           NEW.last_sequence IS DISTINCT FROM OLD.last_sequence
        OR NEW.telemetry_count IS DISTINCT FROM OLD.telemetry_count
      ) THEN
        RAISE EXCEPTION 'safety_sessions: kapalı oturuma telemetri yazılamaz'
          USING ERRCODE = 'check_violation',
                CONSTRAINT = 'safety_sessions_closed_frozen';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER safety_sessions_status_guard
      BEFORE UPDATE ON safety_sessions
      FOR EACH ROW EXECUTE FUNCTION safety_session_status_guard();
  `);

  // --- Telemetri ---
  //
  // Partition anahtarı **sunucu zamanıdır**, istemci zamanı değil: istemci saati
  // manipüle edilebilir ve kayıt yanlış partition'a düşerdi.
  pgm.sql(`
    CREATE TABLE location_events (
      id BIGSERIAL,
      session_id UUID NOT NULL REFERENCES safety_sessions(id) ON DELETE CASCADE,
      sequence_number BIGINT NOT NULL,

      -- İki zaman birden saklanır ve sunucu zamanı yetkilidir (ADR-0008 §7).
      captured_at TIMESTAMPTZ NOT NULL,
      server_received_at TIMESTAMPTZ NOT NULL DEFAULT now(),

      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      location GEOGRAPHY(Point, 4326) GENERATED ALWAYS AS (
        ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
      ) STORED,
      accuracy_meters REAL NOT NULL,
      speed_mps REAL,
      heading_degrees REAL,

      -- Platformun sahte konum sinyali. Kayda geçer ve risk kurallarına girer; tek
      -- başına kanıt sayılmaz (ADR-0008 §7).
      is_mock_location BOOLEAN NOT NULL DEFAULT FALSE,

      -- Ingest anında PostGIS ile hesaplanır: her değerlendirmede yeniden hesaplamak,
      -- en sık çalışan sorguyu gereksizce pahalılaştırırdı.
      distance_to_service_meters INTEGER NOT NULL,
      -- Bu **tek örneğin** gözlemi; kabul edilmiş (debounce edilmiş) durum oturumdadır.
      geofence_state geofence_state NOT NULL,

      CHECK (latitude BETWEEN -90 AND 90),
      CHECK (longitude BETWEEN -180 AND 180),
      CHECK (accuracy_meters >= 0 AND accuracy_meters <= 100000),
      CHECK (speed_mps IS NULL OR (speed_mps >= 0 AND speed_mps <= 400)),
      CHECK (heading_degrees IS NULL OR (heading_degrees >= 0 AND heading_degrees < 360)),
      CHECK (sequence_number > 0),
      CHECK (distance_to_service_meters >= 0),

      PRIMARY KEY (id, server_received_at)
    ) PARTITION BY RANGE (server_received_at);

    -- Sıra numarasının oturum içinde tekilliği bir UNIQUE index ile **garanti
    -- edilemez**: partition'lı tabloda unique index partition anahtarını içermek
    -- zorundadır ve (session, sequence, received_at) tekilliği hiçbir şey ifade etmez.
    -- Garanti oturum satırı kilidi + last_sequence karşılaştırmasıdır (tek yazma yolu).
    CREATE INDEX idx_location_events_session
      ON location_events (session_id, server_received_at DESC);
    CREATE INDEX idx_location_events_geo ON location_events USING GIST (location);

    CREATE TABLE location_events_default PARTITION OF location_events DEFAULT;
  `);

  // Partition yönetimi.
  //
  // Aylık partition + DEFAULT. DEFAULT bilinçlidir: partition oluşturmayı unutmak
  // telemetriyi **kaybetmek** olurdu ve güvenlik verisinde bu kabul edilemez.
  // İzleyici ileri aylar için partition açar; DEFAULT yalnızca emniyet ağıdır.
  //
  // DEFAULT partition'da hedef aralığa ait satır varsa yeni partition oluşturmak
  // başarısız olur; bu durumda fonksiyon hiçbir şey yapmaz ve NULL döner (satırlar
  // DEFAULT'ta kalır, veri kaybı yoktur).
  pgm.sql(`
    CREATE OR REPLACE FUNCTION safety_ensure_location_partition(target TIMESTAMPTZ)
      RETURNS TEXT
      LANGUAGE plpgsql
      SET search_path = pg_catalog, public, pg_temp
    AS $$
    DECLARE
      period_start DATE := date_trunc('month', target)::date;
      period_end DATE := (date_trunc('month', target) + interval '1 month')::date;
      partition_name TEXT := 'location_events_' || to_char(period_start, 'YYYYMM');
    BEGIN
      IF to_regclass('public.' || partition_name) IS NOT NULL THEN
        RETURN partition_name;
      END IF;

      IF EXISTS (
        SELECT 1 FROM public.location_events_default
         WHERE server_received_at >= period_start AND server_received_at < period_end
      ) THEN
        RETURN NULL;
      END IF;

      -- Şema **açıkça** yazılır: search_path'te pg_catalog önce geldiği için
      -- niteliksiz bir CREATE TABLE sistem kataloğunu hedefler ve reddedilir.
      EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF public.location_events '
        'FOR VALUES FROM (%L) TO (%L)',
        partition_name, period_start, period_end
      );

      RETURN partition_name;
    END;
    $$;
  `);

  // --- Güvenlik olayları ---
  //
  // Kanıttır: append-only. Ham koordinat **taşımaz** (details anahtar kümesi
  // uygulamada kapalıdır): olaylar retention'dan sonra da kalır ve bir olay
  // tablosuna yazılmış koordinat, ham konumu süresiz saklamak demek olurdu.
  pgm.sql(`
    CREATE TABLE safety_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      -- Toplam sıra. Aynı transaction'da yazılan olaylar (ör. oturum açılışı + varış
      -- izleme başlangıcı) aynı zaman damgasını paylaşabilir; kanıt zincirinde
      -- "hangisi önce oldu" sorusu zamana değil bu sıraya dayanır.
      seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
      session_id UUID NOT NULL REFERENCES safety_sessions(id) ON DELETE RESTRICT,
      -- Rezervasyon da tutulur: uyuşmazlık dosyası oturumdan değil rezervasyondan açılır.
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,

      event_type safety_event_type NOT NULL,
      source safety_event_source NOT NULL,
      risk_level safety_risk_level NOT NULL DEFAULT 'NORMAL',

      -- Olayı başlatan kişi (panik, operatör kararı). FK bilinçli olarak yok:
      -- append-only bir tabloda ON DELETE SET NULL bir UPDATE'tir ve trigger onu
      -- reddeder; FK, kişisel veri silme akışını kalıcı olarak kilitlerdi
      -- (audit_logs ile aynı gerekçe, ADR-0013).
      actor_user_id UUID,

      -- Kural kimliği ve sürümü (ADR-0012): hangi kuralın hangi sürümü tetikledi?
      rule_id VARCHAR(40),
      rule_version VARCHAR(20),
      -- ML kaynaklı olaylarda model sürümü ve skor.
      model_version VARCHAR(64),
      anomaly_score NUMERIC(5,4),

      -- Tetikleyen sinyaller: sayısal kanıt, ham konum değil.
      details JSONB NOT NULL DEFAULT '{}'::jsonb,

      -- Sunucu zamanı. İstemci "ne zaman bastım" diyemez. clock_timestamp():
      -- now() transaction başlangıcıdır ve uzun bir transaction'daki olayları
      -- gerçekte olduklarından önceye tarihlerdi.
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

      CHECK (anomaly_score IS NULL OR (anomaly_score >= 0 AND anomaly_score <= 1)),
      CHECK (jsonb_typeof(details) = 'object'),
      -- Kaynak ile kanıt tutarlı olmalı: kural olayı kural kimliği taşır, ML olayı
      -- model sürümü. Aksi hâlde "neden bu olay" sorusu kayıttan yanıtlanamaz.
      CONSTRAINT safety_events_rule_evidence
        CHECK (source <> 'RULE' OR (rule_id IS NOT NULL AND rule_version IS NOT NULL)),
      CONSTRAINT safety_events_ml_evidence
        CHECK (source <> 'ML' OR (model_version IS NOT NULL AND anomaly_score IS NOT NULL)),
      -- Kullanıcı ve operatör olayları kimin başlattığını taşımak zorundadır.
      CONSTRAINT safety_events_actor_required
        CHECK (source NOT IN ('USER','OPERATOR') OR actor_user_id IS NOT NULL)
    );

    CREATE INDEX idx_safety_events_session ON safety_events (session_id, seq);
    CREATE INDEX idx_safety_events_booking ON safety_events (booking_id, occurred_at);
    -- Operatör: "son 24 saatte yükselen olaylar".
    CREATE INDEX idx_safety_events_risk
      ON safety_events (risk_level, occurred_at DESC) WHERE risk_level <> 'NORMAL';
    -- Her kabul edilen panik **bir** olaydır. Uygulama zaten oturum kilidi altında
    -- tekilleştirir; bu index eşzamanlı iki isteğin ikisinin de geçtiği bir kod
    -- yolunun (bugün ya da ileride) aynı panik için ikinci olay yazmasını imkânsız kılar.
    CREATE UNIQUE INDEX uq_safety_events_panic
      ON safety_events (session_id, ((details->>'panicNumber')::int))
      WHERE event_type = 'PANIC_RAISED';
    ALTER TABLE safety_events ADD CONSTRAINT safety_events_panic_number
      CHECK (event_type <> 'PANIC_RAISED' OR (details ? 'panicNumber'));
  `);

  // --- Risk değerlendirmeleri ---
  //
  // Her değerlendirme kaydedilir, yalnızca alarm üretenler değil. Nedeni ölçümdür:
  // yanlış alarm oranının paydası "kaç değerlendirme yapıldı"dır (research-metrics §2.4).
  pgm.sql(`
    CREATE TABLE safety_risk_assessments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id UUID NOT NULL REFERENCES safety_sessions(id) ON DELETE RESTRICT,
      -- Kaydedilen (uygulanan) seviye ve toplamanın **önerdiği** seviye ayrıdır:
      -- EMERGENCY otomatik düşmez, bu yüzden ikisi farklı olabilir.
      risk_level safety_risk_level NOT NULL,
      computed_risk_level safety_risk_level NOT NULL,
      previous_risk_level safety_risk_level NOT NULL,
      determined_by VARCHAR(16) NOT NULL,

      ruleset_version VARCHAR(40) NOT NULL,
      aggregation_version VARCHAR(40) NOT NULL,
      triggered_rules JSONB NOT NULL DEFAULT '[]'::jsonb,

      -- ML destekleyici sinyaldir: yoksa değerlendirme yine yapılır.
      anomaly_model_version VARCHAR(64),
      anomaly_score NUMERIC(5,4),
      anomaly_quality NUMERIC(5,4),
      anomaly_available BOOLEAN NOT NULL DEFAULT FALSE,
      anomaly_unavailable_reason VARCHAR(32),
      anomaly_contributions JSONB NOT NULL DEFAULT '[]'::jsonb,

      -- Rota tahmini: hangi kaynak (altyapı) üretti. NULL ise kullanılamadı.
      route_provider VARCHAR(32),

      -- Kullanılamayan sinyaller **açıkça** kaydedilir: eksik telemetriyi sessizce
      -- "normal" saymak, güvenlik sisteminin en tehlikeli hatasıdır (ADR-0008 §2).
      unavailable_signals JSONB NOT NULL DEFAULT '[]'::jsonb,
      -- Normalize edilmiş sinyaller (beklenen/gözlenen). Ham koordinat içermez.
      signals JSONB NOT NULL DEFAULT '{}'::jsonb,

      evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      latency_ms INTEGER NOT NULL DEFAULT 0,

      CHECK (anomaly_score IS NULL OR (anomaly_score >= 0 AND anomaly_score <= 1)),
      CHECK (anomaly_quality IS NULL OR (anomaly_quality >= 0 AND anomaly_quality <= 1)),
      CHECK ((anomaly_score IS NOT NULL) = anomaly_available),
      CHECK ((anomaly_model_version IS NOT NULL) = anomaly_available),
      CHECK (anomaly_available OR anomaly_unavailable_reason IS NOT NULL),
      CHECK (determined_by IN ('USER','RULE','ML','OPERATOR','NONE')),
      CHECK (latency_ms >= 0),
      CHECK (jsonb_typeof(triggered_rules) = 'array'),
      CHECK (jsonb_typeof(anomaly_contributions) = 'array'),
      CHECK (jsonb_typeof(unavailable_signals) = 'array'),
      CHECK (jsonb_typeof(signals) = 'object')
    );

    CREATE INDEX idx_safety_assessments_session
      ON safety_risk_assessments (session_id, evaluated_at DESC);
    CREATE INDEX idx_safety_assessments_version
      ON safety_risk_assessments (ruleset_version, evaluated_at DESC);
  `);

  // Güvenlik kaydı değiştirilemez ve silinemez.
  //
  // `booking_match_results` ile aynı gerekçe ama daha ağır bir sonuçla: bir güvenlik
  // olayı uyuşmazlıkta ve olası bir adli süreçte kanıttır. Retention olayları değil
  // **ham konum örneklerini** hedefler.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION safety_records_immutable() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, pg_temp
    AS $$
    BEGIN
      RAISE EXCEPTION '% append-only: % engellendi', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'restrict_violation';
    END;
    $$;

    CREATE TRIGGER safety_events_immutable
      BEFORE UPDATE OR DELETE ON safety_events
      FOR EACH ROW EXECUTE FUNCTION safety_records_immutable();

    CREATE TRIGGER safety_risk_assessments_immutable
      BEFORE UPDATE OR DELETE ON safety_risk_assessments
      FOR EACH ROW EXECUTE FUNCTION safety_records_immutable();

    REVOKE UPDATE, DELETE, TRUNCATE ON safety_events FROM PUBLIC;
    REVOKE UPDATE, DELETE, TRUNCATE ON safety_risk_assessments FROM PUBLIC;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS safety_risk_assessments_immutable ON safety_risk_assessments;
    DROP TRIGGER IF EXISTS safety_events_immutable ON safety_events;
    DROP FUNCTION IF EXISTS safety_records_immutable();

    DROP TABLE IF EXISTS safety_risk_assessments;
    DROP TABLE IF EXISTS safety_events;

    DROP FUNCTION IF EXISTS safety_ensure_location_partition(TIMESTAMPTZ);
    DROP TABLE IF EXISTS location_events;

    DROP TRIGGER IF EXISTS safety_sessions_status_guard ON safety_sessions;
    DROP FUNCTION IF EXISTS safety_session_status_guard();
    DROP TABLE IF EXISTS safety_sessions;

    DROP TYPE IF EXISTS safety_closure_reason;
    DROP TYPE IF EXISTS geofence_state;
    DROP TYPE IF EXISTS safety_event_type;
    DROP TYPE IF EXISTS safety_event_source;
    DROP TYPE IF EXISTS safety_risk_level;
    DROP TYPE IF EXISTS safety_session_status;
  `);
};
