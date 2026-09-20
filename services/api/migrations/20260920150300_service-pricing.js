/**
 * Hizmet katalogu fiyatlandırması (Faz 4 review bulgusu).
 *
 * Rezervasyon fiyatı istemciden geliyordu: müşteri (veya anlaşmalı bir müşteri-sağlayıcı
 * çifti) keyfî düşük bir tutar kaydedebilir, komisyon ve GMV metriklerini manipüle
 * edebilirdi. Fiyat artık **sunucuda katalogdan** hesaplanır.
 *
 * Sağlayıcıya özel fiyatlandırma (deneyim, bölge, yoğunluk) Faz 7'de scoring/pricing ile
 * gelecek; o zaman da hesaplama sunucuda kalacak, istemci girdisi olmayacak.
 *
 * Invariant iki parçalıdır:
 * - Fiyat alanı, fiyat modeliyle **tutarlı** olmalı (FIXED → taban fiyat, HOURLY → saatlik).
 * - Fiyatsız bir hizmet var olabilir (taslak/henüz fiyatlanmamış) ama **aktif olamaz**:
 *   aktif hizmet rezervasyona açıktır ve fiyatı olmayan bir hizmeti satmak mümkün olmamalı.
 *   Tek parçalı bir CHECK, mevcut fiyatsız satırlar nedeniyle migration'ı da kırardı.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE services
      ADD COLUMN base_price_minor BIGINT,
      ADD COLUMN hourly_rate_minor BIGINT,
      ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'TRY';
  `);

  pgm.sql(`
    ALTER TABLE services
      ADD CONSTRAINT services_pricing_consistent CHECK (
        (base_price_minor IS NULL OR pricing_model = 'FIXED')
        AND (hourly_rate_minor IS NULL OR pricing_model = 'HOURLY')
      ),
      ADD CONSTRAINT services_price_non_negative CHECK (
        coalesce(base_price_minor, 0) >= 0 AND coalesce(hourly_rate_minor, 0) >= 0
      ),
      ADD CONSTRAINT services_currency_upper CHECK (currency = upper(currency));
  `);

  // Fiyatsız hizmetler pasife alınır: aktif kalsalardı rezervasyon akışı fiyat
  // hesaplayamaz ve istek çalışma zamanında patlardı.
  pgm.sql(`
    UPDATE services
       SET active = FALSE
     WHERE base_price_minor IS NULL AND hourly_rate_minor IS NULL;

    ALTER TABLE services
      ADD CONSTRAINT services_active_requires_price CHECK (
        NOT active
        OR (pricing_model = 'FIXED' AND base_price_minor IS NOT NULL)
        OR (pricing_model = 'HOURLY' AND hourly_rate_minor IS NOT NULL)
      );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE services
      DROP CONSTRAINT services_active_requires_price,
      DROP CONSTRAINT services_currency_upper,
      DROP CONSTRAINT services_price_non_negative,
      DROP CONSTRAINT services_pricing_consistent,
      DROP COLUMN currency,
      DROP COLUMN hourly_rate_minor,
      DROP COLUMN base_price_minor;
  `);
};
