/**
 * Ödeme domaini (ADR-0009, ADR-0017).
 *
 * Emek lisanslı ödeme kuruluşu değildir: burada **para tutulmaz**, yalnızca sağlayıcıdaki
 * ödemenin referansı ve durumu izlenir. Kart verisi (PAN, CVV, son kullanma) hiçbir
 * kolonda yoktur ve olamaz — ödeme sayfası/SDK sağlayıcıya aittir (PCI kapsamı dışında
 * kalmak bilinçli bir karardır).
 *
 * Üç tablo üç ayrı işi yapar:
 * - `payments`      : rezervasyonun ödeme durumu (booking aggregate root'un projeksiyonu).
 * - `payment_events`: **gelen** webhook'ların tekilleştirilmiş kaydı (append-only).
 * - `payment_commands`: **giden** çağrıların idempotency kaydı — `external_event_id`
 *   yalnızca geleni tekilleştirir, çift `authorize` göndermeyi engellemez (ADR-0009 §5).
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE payment_status AS ENUM (
      'CREATED',
      'AUTHORIZED',
      'HELD',
      'SERVICE_COMPLETED',
      'RELEASE_PENDING',
      'RELEASED',
      'FAILED',
      'REFUNDED',
      'DISPUTED',
      'AUTHORIZATION_EXPIRED'
    );

    CREATE TYPE payment_command_status AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');
  `);

  pgm.sql(`
    CREATE TABLE payments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
      provider VARCHAR(64) NOT NULL,
      -- Sağlayıcıdaki ödeme referansı. Intent oluşturulana kadar boştur.
      external_payment_id VARCHAR(128),
      amount_minor BIGINT NOT NULL,
      currency CHAR(3) NOT NULL DEFAULT 'TRY',
      -- Kısmi iadeler biriktirilir; ayrı tablo yerine toplam + olay kaydı yeterlidir (ADR-0017 §3).
      refunded_minor BIGINT NOT NULL DEFAULT 0,
      status payment_status NOT NULL DEFAULT 'CREATED',
      authorized_at TIMESTAMPTZ,
      -- ADR-0009 §4: yetkilendirme süresi doludur ve dolabilir. Hold, scheduled_start'tan
      -- günler önce alınabilir; bu kolon olmadan "yetki hâlâ geçerli mi" sorusu
      -- yanıtlanamaz ve release denemesi sağlayıcıda patlar.
      authorization_expires_at TIMESTAMPTZ,
      reauthorization_count INTEGER NOT NULL DEFAULT 0,
      released_at TIMESTAMPTZ,
      failure_code VARCHAR(64),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

      CHECK (amount_minor > 0),
      CHECK (currency = upper(currency)),
      CHECK (refunded_minor >= 0 AND refunded_minor <= amount_minor),
      CHECK (reauthorization_count >= 0),
      -- Yetkilendirilmiş bir ödemenin yetki zamanı ve bitişi bilinmek zorundadır:
      -- biri eksikse süre kontrolü sessizce atlanırdı.
      CONSTRAINT payments_authorization_complete CHECK (
        status NOT IN ('AUTHORIZED', 'HELD', 'SERVICE_COMPLETED', 'RELEASE_PENDING')
        OR (authorized_at IS NOT NULL AND authorization_expires_at IS NOT NULL)
      ),
      CONSTRAINT payments_released_consistent CHECK ((status = 'RELEASED') = (released_at IS NOT NULL)),
      CONSTRAINT payments_failure_code_only_on_failure CHECK (
        failure_code IS NULL OR status IN ('FAILED', 'AUTHORIZATION_EXPIRED')
      )
    );
  `);

  // Bir rezervasyonun **aynı anda** en fazla bir canlı ödemesi olabilir.
  //
  // Düz `UNIQUE (booking_id)` yerine kısmi index: başarısız veya süresi dolmuş bir
  // yetkilendirmeden sonra yeni deneme yapılabilmesi gerekir (ADR-0017 §2). Düz unique,
  // ilk başarısız denemeden sonra rezervasyonu kalıcı olarak ödenemez hâle getirirdi.
  pgm.sql(`
    CREATE UNIQUE INDEX uq_payments_live_per_booking
      ON payments (booking_id)
      WHERE status NOT IN ('FAILED', 'AUTHORIZATION_EXPIRED', 'REFUNDED');

    CREATE UNIQUE INDEX uq_payments_external
      ON payments (provider, external_payment_id)
      WHERE external_payment_id IS NOT NULL;

    CREATE INDEX idx_payments_booking ON payments (booking_id, created_at DESC);
    -- Yetkilendirme süresi yaklaşanları tarayan iş (re-authorization) bu index'i kullanır.
    CREATE INDEX idx_payments_expiring
      ON payments (authorization_expires_at)
      WHERE status IN ('AUTHORIZED', 'HELD', 'SERVICE_COMPLETED');

    CREATE TRIGGER payments_set_updated_at
      BEFORE UPDATE ON payments
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  pgm.sql(`
    CREATE TABLE payment_events (
      id BIGSERIAL PRIMARY KEY,
      payment_id UUID REFERENCES payments(id) ON DELETE RESTRICT,
      provider VARCHAR(64) NOT NULL,
      -- ADR-0009 §7: gelen webhook tekilleştirmesinin tek garantisi budur.
      external_event_id VARCHAR(128) NOT NULL,
      event_type VARCHAR(64) NOT NULL,
      -- Sağlayıcının olay sırası. Out-of-order teslimde geri geçişi reddetmek için
      -- durum makinesiyle birlikte kullanılır (T-10).
      provider_sequence BIGINT,
      from_status payment_status,
      to_status payment_status,
      -- Ham gövde değil, sınıflandırılmış özet: kart verisi ve sağlayıcı ham hata
      -- metni saklanmaz (ADR-0009 §2).
      summary JSONB NOT NULL DEFAULT '{}'::jsonb,
      applied BOOLEAN NOT NULL DEFAULT FALSE,
      occurred_at TIMESTAMPTZ,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT payment_events_unique_external UNIQUE (provider, external_event_id)
    );

    CREATE INDEX idx_payment_events_payment ON payment_events (payment_id, id);
  `);

  // Gelen olay kaydı append-only: silinebilir bir webhook geçmişi, "bu para neden
  // serbest bırakıldı" sorusunu yanıtlayamaz. Yalnızca `applied`/`payment_id`/durum
  // alanları, olayın uygulanması sırasında bir kez doldurulabilir.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION payment_events_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, pg_temp
    AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'payment_events append-only: DELETE engellendi'
          USING ERRCODE = 'restrict_violation';
      END IF;

      IF NEW.provider IS DISTINCT FROM OLD.provider
         OR NEW.external_event_id IS DISTINCT FROM OLD.external_event_id
         OR NEW.event_type IS DISTINCT FROM OLD.event_type
         OR NEW.summary IS DISTINCT FROM OLD.summary
         OR NEW.received_at IS DISTINCT FROM OLD.received_at THEN
        RAISE EXCEPTION 'payment_events kimlik alanları değiştirilemez'
          USING ERRCODE = 'restrict_violation';
      END IF;

      IF OLD.applied AND NOT NEW.applied THEN
        RAISE EXCEPTION 'uygulanmış payment_event geri alınamaz'
          USING ERRCODE = 'restrict_violation';
      END IF;

      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER payment_events_immutable
      BEFORE UPDATE OR DELETE ON payment_events
      FOR EACH ROW EXECUTE FUNCTION payment_events_guard();
  `);

  // Giden çağrı idempotency'si (ADR-0009 §5).
  //
  // Her `authorize`/`capture`/`refund` çağrısı Emek'in ürettiği bir anahtarla gider.
  // Anahtar burada **çağrıdan önce** rezerve edilir: aynı işlem için ikinci bir
  // çağrı denemesi UNIQUE ihlaliyle durur. At-least-once teslimli bir event'ten
  // gelen tekrar, bu sayede çift yetkilendirme üretemez (T-38).
  pgm.sql(`
    CREATE TABLE payment_commands (
      id BIGSERIAL PRIMARY KEY,
      payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
      operation VARCHAR(32) NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      idempotency_key VARCHAR(128) NOT NULL,
      status payment_command_status NOT NULL DEFAULT 'PENDING',
      result_code VARCHAR(64),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,

      CHECK (attempt >= 1),
      -- Sonuçlanmış çağrının sonuç zamanı bilinir; "PENDING ama tamamlanmış" bir kayıt
      -- mutabakatı (Faz 11) yanıltırdı.
      CONSTRAINT payment_commands_completion_consistent
        CHECK ((status = 'PENDING') = (completed_at IS NULL)),
      CONSTRAINT payment_commands_unique_key UNIQUE (idempotency_key),
      CONSTRAINT payment_commands_unique_attempt UNIQUE (payment_id, operation, attempt)
    );

    CREATE INDEX idx_payment_commands_payment ON payment_commands (payment_id, id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS payment_commands;
    DROP TRIGGER IF EXISTS payment_events_immutable ON payment_events;
    DROP FUNCTION IF EXISTS payment_events_guard();
    DROP TABLE IF EXISTS payment_events;
    DROP TABLE IF EXISTS payments;
    DROP TYPE IF EXISTS payment_command_status;
    DROP TYPE IF EXISTS payment_status;
  `);
};
