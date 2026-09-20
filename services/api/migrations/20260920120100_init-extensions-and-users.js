/**
 * Faz 1 — ilk şema: extension'lar, `user_status`/`app_role` enum'ları, `users`, `user_roles`.
 *
 * Şema ham SQL ile yönetilir (ADR-0014): EXCLUDE constraint, partial unique index,
 * PostGIS tipleri ve partitioning gibi gereksinimler ORM şema DSL'leriyle
 * güvenilir biçimde ifade edilemiyor.
 *
 * ADR-0004: "1 insan = 1 User" — e-posta/telefon tekilliği veritabanında zorlanır.
 *
 * Not: `verification_status` / `verification_level` enum'ları bilinçli olarak burada
 * oluşturulmaz. Onları kullanan ilk tablo Faz 3'te (`identity_records`) gelir ve
 * enum'ı kullanan tabloyla aynı migration'da oluşturmak, sonradan enum değeri ekleme
 * (aynı transaction içinde kullanılamaz) sorununu da baştan önler.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE EXTENSION IF NOT EXISTS postgis;
  `);

  pgm.sql(`
    CREATE TYPE user_status AS ENUM ('PENDING','ACTIVE','SUSPENDED','DELETED');
    CREATE TYPE app_role AS ENUM ('CUSTOMER','PROVIDER','ADMIN','SUPPORT');
  `);

  pgm.sql(`
    CREATE TABLE users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      phone VARCHAR(32),
      email VARCHAR(320),
      status user_status NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login_at TIMESTAMPTZ,
      -- Bir kullanıcının en az bir iletişim kanalı olmalı; ikisi de boş bir kayıt
      -- hiçbir akışta anlamlı değildir ve kimliksiz artık kayıt üretir.
      CONSTRAINT users_contact_present CHECK (phone IS NOT NULL OR email IS NOT NULL),
      -- Telefon yalnızca E.164 biçiminde saklanır. Normalize edilmemiş numara
      -- ('+90555...', '0555...', '+90 555...') aynı kişi için üç ayrı hesap demektir;
      -- bu, ADR-0004'ün kapatmayı amaçladığı mükerrer hesap yoludur.
      CONSTRAINT users_phone_e164 CHECK (phone IS NULL OR phone ~ '^\\+[1-9][0-9]{7,14}$')
    );
  `);

  // Partial unique index: NULL iletişim bilgisi tekilliğe dahil değildir.
  // E-posta büyük/küçük harf duyarsız tekildir (Ali@x.com = ali@x.com).
  //
  // Tekillik `DELETED` kullanıcıları da kapsar: silinmiş bir hesabın e-postası/telefonu
  // serbest bırakılırsa aynı iletişim bilgisi yeniden kaydedilebilir ve geçmişten
  // kopuk ikinci bir kimlik oluşur. Hesap silme akışı (Faz 12 retention) iletişim
  // alanlarını anonimleştirir; index'e istisna eklenmez.
  pgm.sql(`
    CREATE UNIQUE INDEX uq_users_email ON users (lower(email)) WHERE email IS NOT NULL;
    CREATE UNIQUE INDEX uq_users_phone ON users (phone) WHERE phone IS NOT NULL;
  `);

  pgm.sql(`
    CREATE TABLE user_roles (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role app_role NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, role)
    );
  `);

  // updated_at uygulama koduna bırakılmaz: tek bir UPDATE yolunu unutmak
  // audit ve senkronizasyon hatalarına yol açar.
  // Fonksiyon önceki migration'da tanımlıdır (paylaşılan).
  pgm.sql(`
    CREATE TRIGGER users_set_updated_at
      BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS users_set_updated_at ON users;
    DROP TABLE IF EXISTS user_roles;
    DROP TABLE IF EXISTS users;
    DROP TYPE IF EXISTS app_role;
    DROP TYPE IF EXISTS user_status;
  `);
  // Extension'lar bilinçli olarak düşürülmez: aynı veritabanını paylaşan başka
  // şemalar/objeler onlara bağlı olabilir ve DROP EXTENSION geri dönüşü zordur.
};
