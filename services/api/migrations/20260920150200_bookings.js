/**
 * Booking domaini (ADR-0006).
 *
 * Durumlar ENUM'dur: serbest metin `VARCHAR` geçersiz durumun yazılmasına izin verirdi.
 * Geçiş kuralları uygulamada merkezî bir transition map'te, **invariant'lar** ise burada:
 * uygulama ilk savunma, veritabanı son savunmadır.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE booking_status AS ENUM (
      'REQUESTED',
      'MATCHED',
      'PROVIDER_PENDING',
      'CONFIRMED',
      'PAYMENT_AUTHORIZED',
      'SCHEDULED',
      'PROVIDER_ARRIVING',
      'CHECKED_IN',
      'IN_PROGRESS',
      'CHECKED_OUT',
      'CUSTOMER_CONFIRMED',
      'COMPLETED',
      'SETTLED',
      'CANCELLED',
      'DISPUTED',
      'SAFETY_HOLD'
    );

    CREATE TYPE booking_request_status AS ENUM ('CREATED','MATCHING','MATCHED','EXPIRED','CANCELLED');
  `);

  pgm.sql(`
    CREATE TABLE booking_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id UUID NOT NULL REFERENCES customer_profiles(user_id) ON DELETE CASCADE,
      service_id UUID NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
      address_id UUID NOT NULL REFERENCES addresses(id) ON DELETE RESTRICT,
      -- Ar-Ge izlenebilirliği (ADR-0012): ham metin, yapılandırılmış çıktı ve parser
      -- sürümü birlikte saklanır ki v1/v2 karşılaştırılabilsin.
      raw_text TEXT,
      structured_request JSONB,
      parser_version VARCHAR(64),
      parser_confidence NUMERIC(5,4),
      preferred_start TIMESTAMPTZ NOT NULL,
      preferred_end TIMESTAMPTZ NOT NULL,
      duration_minutes INTEGER NOT NULL,
      status booking_request_status NOT NULL DEFAULT 'CREATED',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (preferred_end > preferred_start),
      CHECK (duration_minutes > 0 AND duration_minutes <= 1440),
      -- Talep penceresi istenen süreyi barındırmalı.
      CHECK (preferred_end - preferred_start >= make_interval(mins => duration_minutes)),
      CHECK (parser_confidence IS NULL OR (parser_confidence >= 0 AND parser_confidence <= 1)),
      -- Parser sürümü ile çıktı birlikte anlamlıdır (ADR-0012).
      CHECK ((structured_request IS NULL) = (parser_version IS NULL))
    );

    CREATE INDEX idx_booking_requests_customer ON booking_requests (customer_id, created_at DESC);

    CREATE TRIGGER booking_requests_set_updated_at
      BEFORE UPDATE ON booking_requests
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  pgm.sql(`
    CREATE TABLE bookings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id UUID REFERENCES booking_requests(id) ON DELETE SET NULL,
      customer_id UUID NOT NULL REFERENCES customer_profiles(user_id) ON DELETE RESTRICT,
      -- R-14 kararı: REQUESTED durumunda sağlayıcı henüz yok, bu yüzden nullable;
      -- MATCHED ve sonrasında zorunluluk CHECK ile garanti edilir.
      provider_id UUID REFERENCES provider_profiles(user_id) ON DELETE RESTRICT,
      service_id UUID NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
      address_id UUID NOT NULL REFERENCES addresses(id) ON DELETE RESTRICT,
      scheduled_start TIMESTAMPTZ NOT NULL,
      scheduled_end TIMESTAMPTZ NOT NULL,
      slot TSTZRANGE GENERATED ALWAYS AS (tstzrange(scheduled_start, scheduled_end, '[)')) STORED,
      -- Para her zaman minor unit ve tam sayı: float ile para hesabı yasak.
      price_minor BIGINT NOT NULL,
      currency CHAR(3) NOT NULL DEFAULT 'TRY',
      status booking_status NOT NULL DEFAULT 'REQUESTED',
      cancelled_at TIMESTAMPTZ,
      cancellation_reason VARCHAR(160),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

      CHECK (scheduled_end > scheduled_start),
      CHECK (price_minor >= 0),
      CHECK (currency = upper(currency)),
      -- Kendi kendine rezervasyon: tek User/iki profil modeli buna izin verirdi ve
      -- GMV/review/ESG metriklerini manipüle etme yolu olurdu (ADR-0004 §9).
      CONSTRAINT bookings_not_self CHECK (customer_id <> provider_id),
      -- Sağlayıcı yalnızca REQUESTED durumunda boş olabilir.
      CONSTRAINT bookings_provider_required CHECK (status = 'REQUESTED' OR provider_id IS NOT NULL),
      CONSTRAINT bookings_cancellation_consistent
        CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL))
    );
  `);

  // Çakışma engeli: aynı sağlayıcı için üst üste binen iki aktif rezervasyon olamaz.
  //
  // Predikat kritik: iptal edilmiş rezervasyonlar hariç tutulmazsa, iptal edilen bir
  // randevu o sağlayıcının takviminde o saati **kalıcı olarak** bloklardı.
  // Redis lock yalnızca gereksiz çakışma denemelerini azaltan optimizasyondur;
  // doğruluğun kaynağı bu constraint'tir (ADR-0006 §8).
  pgm.sql(`
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_no_overlap
      EXCLUDE USING GIST (provider_id WITH =, slot WITH &&)
      WHERE (status <> 'CANCELLED' AND provider_id IS NOT NULL);

    CREATE INDEX idx_bookings_provider_time ON bookings (provider_id, scheduled_start);
    CREATE INDEX idx_bookings_customer_time ON bookings (customer_id, scheduled_start DESC);
    CREATE INDEX idx_bookings_status ON bookings (status) WHERE status <> 'SETTLED';

    CREATE TRIGGER bookings_set_updated_at
      BEFORE UPDATE ON bookings
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  pgm.sql(`
    CREATE TABLE booking_status_history (
      id BIGSERIAL PRIMARY KEY,
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      from_status booking_status,
      to_status booking_status NOT NULL,
      changed_by UUID REFERENCES users(id),
      reason VARCHAR(160),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- İlk kayıt dışında kaynak durum zorunludur; "nereden geldi" bilgisi olmadan
      -- geçmiş denetlenemez.
      CHECK (from_status IS NOT NULL OR to_status = 'REQUESTED')
    );

    CREATE INDEX idx_booking_status_history_booking
      ON booking_status_history (booking_id, id);
  `);

  // Geçmiş append-only'dir (ADR-0006 §4): değiştirilebilir bir geçmiş, denetim değeri taşımaz.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION booking_history_immutable() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, pg_temp
    AS $$
    BEGIN
      RAISE EXCEPTION 'booking_status_history append-only: % engellendi', TG_OP
        USING ERRCODE = 'restrict_violation';
    END;
    $$;

    CREATE TRIGGER booking_status_history_no_update
      BEFORE UPDATE OR DELETE ON booking_status_history
      FOR EACH ROW EXECUTE FUNCTION booking_history_immutable();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS booking_status_history_no_update ON booking_status_history;
    DROP FUNCTION IF EXISTS booking_history_immutable();
    DROP TABLE IF EXISTS booking_status_history;
    DROP TABLE IF EXISTS bookings;
    DROP TABLE IF EXISTS booking_requests;
    DROP TYPE IF EXISTS booking_request_status;
    DROP TYPE IF EXISTS booking_status;
  `);
};
