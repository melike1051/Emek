/**
 * Kimlik doğrulama domaini (ADR-0004, ADR-0005).
 *
 * `auth_subjects` (Faz 2) **oturum kimliğini** tutar: Firebase `sub` → `users.id`.
 * Bu migration'daki `identity_records` ise **doğrulanmış gerçek kimliği** tutar ve
 * "1 insan = 1 User" tekilliğini veritabanı seviyesinde zorlar.
 *
 * Ham kimlik verisi (T.C. kimlik numarası, isim, doğum tarihi, belge görüntüsü)
 * **hiçbir sütunda saklanmaz**. Saklanan: sağlayıcı referansı ve KMS anahtarıyla
 * üretilmiş HMAC `identity_hash`.
 */

exports.up = (pgm) => {
  // Faz 1'de bilinçli olarak ertelenmişti: enum'ı kullanan ilk tablo burada geliyor.
  pgm.sql(`
    CREATE TYPE verification_status AS ENUM ('PENDING','VERIFIED','REJECTED','EXPIRED');
    CREATE TYPE verification_level AS ENUM (
      'UNVERIFIED','PHONE_VERIFIED','IDENTITY_VERIFIED','PROVIDER_VERIFIED','FULLY_VERIFIED'
    );
    -- NFC tek başına "telefonu tutan = kart sahibi" kanıtı değildir (ADR-0005).
    -- Akışlar asgari güvence seviyesi talep edebilir; recovery en yükseğini ister.
    CREATE TYPE assurance_level AS ENUM ('LOW','SUBSTANTIAL','HIGH');
    CREATE TYPE verification_purpose AS ENUM ('ACCOUNT_VERIFICATION','ACCOUNT_RECOVERY');
  `);

  pgm.sql(`
    CREATE TABLE identity_records (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      -- Bir kullanıcının tek doğrulanmış kimlik kaydı olur.
      user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
      verification_provider VARCHAR(80) NOT NULL,
      provider_subject_id VARCHAR(255) NOT NULL,
      -- Ham kimlik verisinden adapter içinde üretilen HMAC (ADR-0004 §4).
      identity_hash CHAR(64),
      -- Teşhis amaçlıdır: hangi kayıt hangi anahtar sürümüyle üretildi.
      -- Rotasyon bir seçenek DEĞİLDİR (ADR-0004 §5): ham girdi saklanmadığı için
      -- mevcut hash'ler yeniden hesaplanamaz.
      hash_key_version VARCHAR(40) NOT NULL,
      verification_level verification_level NOT NULL DEFAULT 'UNVERIFIED',
      verification_status verification_status NOT NULL DEFAULT 'PENDING',
      assurance_level assurance_level NOT NULL DEFAULT 'LOW',
      verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- Aynı sağlayıcının aynı subject'i iki kullanıcıya bağlanamaz.
      UNIQUE (verification_provider, provider_subject_id),
      CHECK ((verification_status = 'VERIFIED') = (verified_at IS NOT NULL)),
      -- Doğrulanmış bir kayıt hash taşımak zorundadır: tekillik kontrolü buna dayanır.
      CHECK (verification_status <> 'VERIFIED' OR identity_hash IS NOT NULL)
    );

    -- BİRİNCİL TEKİLLİK (ADR-0004 §2): sağlayıcıdan BAĞIMSIZ.
    -- (verification_provider, provider_subject_id) tek başına yeterli değildir; aynı kişi
    -- A sağlayıcısıyla doğrulanıp sonra B ile doğrulanırsa orada çakışma olmaz.
    CREATE UNIQUE INDEX uq_identity_records_hash
      ON identity_records (identity_hash) WHERE identity_hash IS NOT NULL;

    CREATE TRIGGER identity_records_set_updated_at
      BEFORE UPDATE ON identity_records
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  pgm.sql(`
    CREATE TABLE verification_attempts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider VARCHAR(80) NOT NULL,
      external_session_id VARCHAR(255) NOT NULL,
      method VARCHAR(40) NOT NULL,
      purpose verification_purpose NOT NULL DEFAULT 'ACCOUNT_VERIFICATION',
      status verification_status NOT NULL DEFAULT 'PENDING',
      -- Sınıflandırılmış sonuç kodu; sağlayıcının ham hata metni saklanmaz.
      result_code VARCHAR(80),
      assurance_level assurance_level,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      -- Aynı sağlayıcı oturumu iki kez kaydedilemez; callback replay'i burada da kırılır.
      UNIQUE (provider, external_session_id),
      CHECK (expires_at > created_at),
      CHECK ((status = 'PENDING') = (completed_at IS NULL))
    );

    CREATE INDEX idx_verification_attempts_user ON verification_attempts (user_id, created_at DESC);
    -- Süresi dolmuş oturumları toplu kapatan iş için.
    CREATE INDEX idx_verification_attempts_expiry ON verification_attempts (expires_at)
      WHERE status = 'PENDING';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS verification_attempts;
    DROP TABLE IF EXISTS identity_records;
    DROP TYPE IF EXISTS verification_purpose;
    DROP TYPE IF EXISTS assurance_level;
    DROP TYPE IF EXISTS verification_level;
    DROP TYPE IF EXISTS verification_status;
  `);
};
