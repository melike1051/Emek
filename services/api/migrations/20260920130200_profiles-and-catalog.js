/**
 * Profiller ve hizmet katalogu.
 *
 * ADR-0004: aynı `users` kaydı hem `customer_profiles` hem `provider_profiles`
 * taşıyabilir — "1 insan = 1 User, çok rol".
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE provider_state AS ENUM ('DRAFT','PENDING_REVIEW','APPROVED','REJECTED','SUSPENDED');
    CREATE TYPE skill_level AS ENUM ('BEGINNER','INTERMEDIATE','EXPERT');
    CREATE TYPE pricing_model AS ENUM ('FIXED','HOURLY');
  `);

  pgm.sql(`
    CREATE TABLE customer_profiles (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      display_name VARCHAR(120) NOT NULL,
      preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (length(btrim(display_name)) > 0)
    );

    CREATE TRIGGER customer_profiles_set_updated_at
      BEFORE UPDATE ON customer_profiles
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  pgm.sql(`
    CREATE TABLE provider_profiles (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      display_name VARCHAR(120) NOT NULL,
      bio TEXT,
      experience_years NUMERIC(4,1),
      -- Kalite metrikleri türetilmiş değerlerdir; review akışı (Faz 5) günceller.
      rating_avg NUMERIC(4,2),
      rating_count INTEGER NOT NULL DEFAULT 0,
      quality_score NUMERIC(6,4),
      state provider_state NOT NULL DEFAULT 'DRAFT',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (length(btrim(display_name)) > 0),
      CHECK (experience_years IS NULL OR (experience_years >= 0 AND experience_years <= 80)),
      CHECK (rating_avg IS NULL OR (rating_avg >= 1 AND rating_avg <= 5)),
      CHECK (rating_count >= 0),
      -- Puan ortalaması ve sayacı birbirini tutmalı: biri varsa diğeri de olmalı.
      CHECK ((rating_avg IS NULL) = (rating_count = 0))
    );

    CREATE INDEX idx_provider_profiles_state ON provider_profiles (state);

    CREATE TRIGGER provider_profiles_set_updated_at
      BEFORE UPDATE ON provider_profiles
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  pgm.sql(`
    CREATE TABLE service_categories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      slug VARCHAR(80) NOT NULL UNIQUE,
      name VARCHAR(120) NOT NULL,
      description TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
    );
  `);

  pgm.sql(`
    CREATE TABLE services (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      category_id UUID NOT NULL REFERENCES service_categories(id) ON DELETE RESTRICT,
      slug VARCHAR(80) NOT NULL UNIQUE,
      name VARCHAR(160) NOT NULL,
      description TEXT,
      default_duration_minutes INTEGER,
      pricing_model pricing_model NOT NULL DEFAULT 'FIXED',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
      CHECK (default_duration_minutes IS NULL OR
             (default_duration_minutes > 0 AND default_duration_minutes <= 1440))
    );

    CREATE INDEX idx_services_category ON services (category_id) WHERE active;
  `);

  pgm.sql(`
    CREATE TABLE skills (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      slug VARCHAR(80) NOT NULL UNIQUE,
      name VARCHAR(120) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
    );
  `);

  pgm.sql(`
    CREATE TABLE provider_skills (
      provider_id UUID NOT NULL REFERENCES provider_profiles(user_id) ON DELETE CASCADE,
      skill_id UUID NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
      level skill_level NOT NULL DEFAULT 'BEGINNER',
      -- Yetkinlik doğrulaması Faz 3'te (provider verification) anlam kazanır;
      -- matching hard constraint'i doğrulanmış yetkinliğe bakacak (ADR-0007).
      verified BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (provider_id, skill_id)
    );

    CREATE INDEX idx_provider_skills_skill ON provider_skills (skill_id) WHERE verified;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS provider_skills;
    DROP TABLE IF EXISTS skills;
    DROP TABLE IF EXISTS services;
    DROP TABLE IF EXISTS service_categories;
    DROP TABLE IF EXISTS provider_profiles;
    DROP TABLE IF EXISTS customer_profiles;
    DROP TYPE IF EXISTS pricing_model;
    DROP TYPE IF EXISTS skill_level;
    DROP TYPE IF EXISTS provider_state;
  `);
};
