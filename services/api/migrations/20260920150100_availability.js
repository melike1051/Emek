/**
 * Sağlayıcı müsaitliği ve istisnaları.
 *
 * Faz 4'te müsaitlik **somut zaman aralıkları** olarak tutulur. Tekrarlayan kural
 * (RRULE) motoru bilinçli olarak yazılmadı: matching (Faz 7) gerçek ihtiyacı
 * netleştirmeden bir tekrarlama motoru yazmak, kullanılmayan karmaşıklık üretir.
 * Sağlayıcı arayüzü haftalık şablondan somut aralık üretebilir; genişletme mantığı
 * gerektiğinde uygulama katmanında eklenir ve bu tablo değişmez.
 *
 * Çakışma engeli `EXCLUDE USING GIST` ile veritabanındadır: aynı sağlayıcı için
 * üst üste binen iki müsaitlik penceresi, "hangi pencere geçerli" belirsizliği üretirdi.
 */

exports.up = (pgm) => {
  // EXCLUDE USING GIST, UUID eşitliğini (provider_id WITH =) aynı indekste aralık
  // örtüşmesiyle birleştirir. Bunun için btree_gist gerekir: PostgreSQL'in varsayılan
  // GIST operatör sınıfları UUID eşitliğini desteklemez.
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS btree_gist;`);

  pgm.sql(`
    CREATE TABLE availability (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider_id UUID NOT NULL REFERENCES provider_profiles(user_id) ON DELETE CASCADE,
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      -- Sorgular ve çakışma kontrolü aralık üzerinden çalışır; kolon türetilmiştir ki
      -- uçlarla aralık birbirinden ayrışamasın.
      slot TSTZRANGE GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (ends_at > starts_at),
      -- Anlamsız derecede kısa/uzun pencereler veri hatasıdır.
      CHECK (ends_at - starts_at >= interval '15 minutes'),
      CHECK (ends_at - starts_at <= interval '24 hours'),
      EXCLUDE USING GIST (provider_id WITH =, slot WITH &&)
    );

    CREATE INDEX idx_availability_provider_slot ON availability USING GIST (provider_id, slot);
  `);

  pgm.sql(`
    CREATE TABLE availability_exceptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider_id UUID NOT NULL REFERENCES provider_profiles(user_id) ON DELETE CASCADE,
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      slot TSTZRANGE GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,
      reason VARCHAR(160),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (ends_at > starts_at)
    );

    -- İstisnalar üst üste binebilir (iki farklı nedenle aynı gün kapatılabilir);
    -- bu yüzden EXCLUDE yok, yalnızca arama indeksi var.
    CREATE INDEX idx_availability_exceptions_provider_slot
      ON availability_exceptions USING GIST (provider_id, slot);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS availability_exceptions;
    DROP TABLE IF EXISTS availability;
  `);
  // btree_gist düşürülmez: bookings gibi başka objeler ona bağlı olabilir ve
  // DROP EXTENSION geri dönüşü zordur (ADR-0014).
};
