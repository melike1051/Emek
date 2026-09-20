/**
 * Paylaşılan `set_updated_at()` trigger fonksiyonu.
 *
 * Kendi migration'ında tutulur: birden fazla tablo (users, profiller, bookings, ...)
 * bu fonksiyona bağlanacak. Fonksiyon, onu ilk kullanan tablonun migration'ına
 * gömülürse o migration'ın `down` yönü, sonraki tabloların trigger'larını kırar.
 *
 * `search_path` sabitlenir: değiştirilebilir search_path, trigger fonksiyonları için
 * bilinen bir ayrıcalık yükseltme yüzeyidir.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, pg_temp
    AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$;
  `);
};

exports.down = (pgm) => {
  // Fonksiyona bağlı trigger kalmışsa DROP başarısız olur; bu istenen davranıştır
  // (sessizce bozulmuş bir trigger bırakmaktan iyidir).
  pgm.sql(`DROP FUNCTION IF EXISTS set_updated_at();`);
};
