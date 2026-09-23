/**
 * Faz 14 — ölçümle gerekçelendirilmiş index değişiklikleri.
 *
 * Bu migration **index eklemez**. EXP-007 veritabanı profili, sıcak yolların
 * (müsaitlik kilidi, çakışma kontrolü, kapasite okuması, rezervasyon listesi,
 * outbox taraması) tamamının zaten index scan kullandığını ve 0.2 ms altında
 * kaldığını gösterdi; eklenecek bir index için kanıt yoktur
 * (CLAUDE.md: "gerçek darboğaz kanıtlanmadan index ekleme").
 *
 * Tek değişiklik, **fazlalık** bir index'in kaldırılmasıdır.
 *
 * `idx_availability_provider_slot`, `availability_provider_id_slot_excl` ile
 * birebir aynıdır: ikisi de `gist (provider_id, slot)`. İkincisi
 * `EXCLUDE USING gist (provider_id WITH =, slot WITH &&)` kısıtının dayandığı
 * index'tir ve **düşürülemez** — çakışma garantisi ona bağlıdır. Dolayısıyla
 * fazlalık olan, elle eklenmiş birincisidir.
 *
 * Ölçüm (yerel, emülasyonlu x86_64 Postgres; 14.000 satırlık `availability`):
 *
 * | Ölçüm                                   | Index varken | Index yokken |
 * | --------------------------------------- | ------------ | ------------ |
 * | 5.000 satır INSERT (4 koşunun ortalaması) | ~424 ms      | ~347 ms      |
 * | Index boyutu                            | +1856 kB     | —            |
 * | `availability_window_lock` planı        | Index Scan   | Index Scan   |
 * | Aynı sorgunun maliyet tahmini           | 0.29..8.31   | 0.29..8.31   |
 *
 * Yani okuma planı ve maliyeti **değişmiyor** (planlayıcı kısıt index'ine geçiyor),
 * yazma ~%18 ucuzluyor ve 1856 kB yer geri kazanılıyor. `availability` her booking
 * create'inde okunup kilitlenen, sağlayıcılar tarafından yazılan sıcak bir tablodur.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS idx_availability_provider_slot;`);
};

exports.down = (pgm) => {
  // Geri alma fazlalığı geri getirir: doğruluk açısından fark yoktur, yalnızca
  // migration'ın simetrik kalması için.
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_availability_provider_slot
      ON availability USING gist (provider_id, slot);
  `);
};
