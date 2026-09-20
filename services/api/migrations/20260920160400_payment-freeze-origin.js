/**
 * Dondurma öncesi ödeme durumu (Faz 5 review bulgusu C2).
 *
 * Uyuşmazlık veya güvenlik askısı ödemeyi `DISPUTED` yapar. Çözümden sonra ödemenin
 * **hangi duruma** döneceği bilinmek zorundadır:
 *
 * - Hizmet sırasında askıya alınmış bir ödeme `HELD`'e döner ve normal akışla devam eder.
 * - Hizmet tamamlandıktan sonra açılan bir uyuşmazlık çözüldüğünde ödeme
 *   `SERVICE_COMPLETED`'a döner ve release edilebilir hâle gelir.
 *
 * Bu kolon olmadan tek bir "geri dönüş" durumu seçmek zorunda kalırdık ve diğer senaryoda
 * ödeme kilitli kalırdı: sağlayıcı lehine karar verilmiş bir uyuşmazlıkta bile para ne
 * serbest bırakılabilir ne iade edilebilirdi.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE payments
      ADD COLUMN frozen_from_status payment_status;

    ALTER TABLE payments
      -- Yalnızca dondurulmuş bir ödeme "nereden donduruldu" bilgisi taşır; başka bir
      -- durumda dolu kalması, çözülmüş bir uyuşmazlığın izini yanlış gösterirdi.
      ADD CONSTRAINT payments_freeze_origin_consistent CHECK (
        frozen_from_status IS NULL OR status = 'DISPUTED'
      ),
      -- Dondurulmuş ödeme mutlaka nereye döneceğini bilir: aksi halde çözüm sonrası
      -- hangi duruma dönüleceği belirsiz kalır ve para kilitlenir.
      ADD CONSTRAINT payments_frozen_knows_origin CHECK (
        status <> 'DISPUTED' OR frozen_from_status IS NOT NULL
      );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE payments
      DROP CONSTRAINT payments_frozen_knows_origin,
      DROP CONSTRAINT payments_freeze_origin_consistent,
      DROP COLUMN frozen_from_status;
  `);
};
