/**
 * Oturum kimliklerine yaşam döngüsü eklenir (hesap kurtarma — ADR-0004 §7).
 *
 * Faz 2'deki `UNIQUE (user_id, provider)` kısıtı, bir kullanıcının aynı sağlayıcıda
 * yalnızca tek bir oturum kimliği olabileceğini varsayıyordu. Hesap kurtarma tam olarak
 * bunu ihlal eder: kullanıcı telefonunu kaybeder, yeni bir sağlayıcı hesabıyla gelir ve
 * bu yeni kimliğin mevcut kullanıcıya bağlanması gerekir.
 *
 * Eski kimliği **aktif bırakmak güvenlik açığıdır**: telefon numaraları operatörler
 * tarafından yeniden tahsis edilir ve eski numarayı alan biri hesaba girebilirdi.
 * Bu yüzden kurtarmada eski kimlikler `REVOKED` olur ve kimlik doğrulama yalnızca
 * `ACTIVE` kimlikleri kabul eder.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE auth_subject_status AS ENUM ('ACTIVE','REVOKED');

    ALTER TABLE auth_subjects
      DROP CONSTRAINT auth_subjects_user_id_provider_key,
      ADD COLUMN status auth_subject_status NOT NULL DEFAULT 'ACTIVE',
      ADD COLUMN revoked_at TIMESTAMPTZ,
      ADD CONSTRAINT auth_subjects_revocation_consistent
        CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL));

    -- Bir kullanıcının sağlayıcı başına en fazla bir AKTİF oturum kimliği olur;
    -- iptal edilmiş kimlikler tarihsel kayıt olarak kalır.
    CREATE UNIQUE INDEX uq_auth_subjects_active_per_provider
      ON auth_subjects (user_id, provider) WHERE status = 'ACTIVE';

    CREATE INDEX idx_auth_subjects_active ON auth_subjects (provider, provider_subject)
      WHERE status = 'ACTIVE';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_auth_subjects_active;
    DROP INDEX IF EXISTS uq_auth_subjects_active_per_provider;

    ALTER TABLE auth_subjects
      DROP CONSTRAINT auth_subjects_revocation_consistent,
      DROP COLUMN revoked_at,
      DROP COLUMN status,
      ADD CONSTRAINT auth_subjects_user_id_provider_key UNIQUE (user_id, provider);

    DROP TYPE IF EXISTS auth_subject_status;
  `);
};
