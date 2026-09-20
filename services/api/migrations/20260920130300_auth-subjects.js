/**
 * `auth_subjects` — kimlik doğrulama sağlayıcısının subject'i ile Emek kullanıcısı eşlemesi.
 *
 * Bu tablo **oturum kimliğiyle** ilgilidir (Firebase `sub` → `users.id`), Faz 3'te gelecek
 * `identity_records` ise **doğrulanmış gerçek kimlikle** (T.C. kimlik referansı / hash).
 * İkisi ayrı domainlerdir: bir kullanıcı kimliğini doğrulamadan da oturum açabilir
 * (`UNVERIFIED` seviye), doğrulanmış kimlik ise ADR-0004'teki tekillik kontrolüne tabidir.
 *
 * Tekillik iki yönlüdür:
 * - Aynı sağlayıcı subject'i iki kullanıcıya bağlanamaz (hesap devralma engeli).
 * - Bir kullanıcının aynı sağlayıcıda iki subject'i olamaz (mükerrer oturum kimliği engeli).
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE auth_subjects (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider VARCHAR(40) NOT NULL DEFAULT 'firebase',
      provider_subject VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (provider, provider_subject),
      UNIQUE (user_id, provider),
      CHECK (length(btrim(provider_subject)) > 0)
    );

    CREATE INDEX idx_auth_subjects_user ON auth_subjects (user_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS auth_subjects;`);
};
