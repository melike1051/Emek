/**
 * Adresler ve sağlayıcı hizmet bölgeleri (PostGIS).
 *
 * Coğrafi filtreleme veri katmanında yapılır (ADR-0003): 10.000 sağlayıcıyı uygulamaya
 * çekip mesafe hesaplamak yerine GIST indeksli sorgu çalışır. Faz 7'deki candidate
 * retrieval bu indekslere dayanacak.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE addresses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label VARCHAR(60),
      city VARCHAR(100) NOT NULL,
      district VARCHAR(100) NOT NULL,
      line TEXT NOT NULL,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      -- Konum, lat/lon'dan türetilir: ikisi ayrı yazılırsa zamanla birbirinden ayrışır
      -- ve "haritada başka, sorguda başka" hatası sessizce oluşur.
      location GEOGRAPHY(Point, 4326) GENERATED ALWAYS AS (
        ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
      ) STORED,
      archived_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (latitude BETWEEN -90 AND 90),
      CHECK (longitude BETWEEN -180 AND 180),
      CHECK (length(btrim(line)) > 0),
      CHECK (length(btrim(city)) > 0),
      CHECK (length(btrim(district)) > 0)
    );

    CREATE INDEX idx_addresses_location ON addresses USING GIST (location);
    -- Kullanıcının aktif adresleri en sık sorgulanan kümedir.
    CREATE INDEX idx_addresses_user ON addresses (user_id) WHERE archived_at IS NULL;

    CREATE TRIGGER addresses_set_updated_at
      BEFORE UPDATE ON addresses
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  pgm.sql(`
    CREATE TABLE provider_service_areas (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider_id UUID NOT NULL REFERENCES provider_profiles(user_id) ON DELETE CASCADE,
      name VARCHAR(80) NOT NULL,
      -- MULTIPOLYGON: bir sağlayıcı birbirine değmeyen bölgelerde çalışabilir
      -- (ör. iki ayrı ilçe). Tek POLYGON bunu ifade edemezdi.
      area GEOGRAPHY(MultiPolygon, 4326) NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- Geçersiz geometri (kendini kesen poligon) sorguları sessizce yanlış sonuç
      -- verdirir; girişte reddedilir.
      CONSTRAINT provider_service_areas_valid CHECK (ST_IsValid(area::geometry)),
      CHECK (length(btrim(name)) > 0)
    );

    CREATE INDEX idx_provider_service_areas_geo ON provider_service_areas USING GIST (area)
      WHERE active;
    CREATE INDEX idx_provider_service_areas_provider ON provider_service_areas (provider_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS provider_service_areas;
    DROP TABLE IF EXISTS addresses;
  `);
};
