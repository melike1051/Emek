/**
 * Event teslim garantisi ve idempotency altyapısı.
 *
 * ADR-0010 §2: event, domain değişikliğiyle **aynı transaction'da** `outbox`'a yazılır;
 * ayrı bir publisher Pub/Sub'a gönderir. "DB commit edildi ama event kayboldu" durumu
 * kabul edilmez. Bu tablolar Faz 2'de kurulur çünkü Faz 3 (`IdentityVerified`),
 * Faz 5 (`PaymentAuthorized`) ve Faz 8 (`SafetyAlertRaised`) garantisi buna dayanır.
 *
 * ADR-0003: idempotency kalıcı veridir, Redis'te tutulmaz. Redis flush'ı çift ödeme
 * veya çift state geçişi üretemez.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE outbox_status AS ENUM ('PENDING','PUBLISHED','FAILED');
  `);

  pgm.sql(`
    CREATE TABLE outbox (
      -- event_id, tüketici tarafında idempotency anahtarıdır (event-catalog.md zarfı).
      event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type VARCHAR(80) NOT NULL,
      event_version INTEGER NOT NULL DEFAULT 1,
      subject_type VARCHAR(80) NOT NULL,
      subject_id UUID,
      payload JSONB NOT NULL,
      correlation_id UUID,
      status outbox_status NOT NULL DEFAULT 'PENDING',
      attempts INTEGER NOT NULL DEFAULT 0,
      -- Hata mesajı değil, sınıflandırılmış neden: payload/hata metni hassas veri taşıyabilir.
      last_error_code VARCHAR(80),
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      published_at TIMESTAMPTZ,
      CHECK (attempts >= 0),
      CHECK ((status = 'PUBLISHED') = (published_at IS NOT NULL))
    );

    -- Publisher yalnızca yayınlanmamış ve zamanı gelmiş kayıtları tarar.
    CREATE INDEX idx_outbox_dispatchable ON outbox (next_attempt_at, occurred_at)
      WHERE status <> 'PUBLISHED';
  `);

  pgm.sql(`
    CREATE TABLE processed_events (
      -- Aynı event farklı consumer'lar tarafından işlenir; tekillik consumer başınadır.
      consumer VARCHAR(80) NOT NULL,
      event_id UUID NOT NULL,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (consumer, event_id)
    );
  `);

  pgm.sql(`
    CREATE TYPE idempotency_status AS ENUM ('IN_PROGRESS','COMPLETED');
  `);

  pgm.sql(`
    CREATE TABLE idempotency_keys (
      scope VARCHAR(120) NOT NULL,
      key VARCHAR(255) NOT NULL,
      -- Aynı key farklı gövdeyle gelirse istek reddedilir (IDEMPOTENCY_KEY_REUSED).
      request_fingerprint CHAR(64) NOT NULL,
      status idempotency_status NOT NULL DEFAULT 'IN_PROGRESS',
      response_status INTEGER,
      response_body JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (scope, key),
      CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL)),
      CHECK (expires_at > created_at)
    );

    CREATE INDEX idx_idempotency_expiry ON idempotency_keys (expires_at);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS idempotency_keys;
    DROP TYPE IF EXISTS idempotency_status;
    DROP TABLE IF EXISTS processed_events;
    DROP TABLE IF EXISTS outbox;
    DROP TYPE IF EXISTS outbox_status;
  `);
};
