/**
 * `users_contact_present` kısıtı yalnızca **aktif** hesaplar için anlamlıdır.
 *
 * Faz 1'de kısıt koşulsuzdu: "her kullanıcının en az bir iletişim kanalı olmalı".
 * Faz 3'te hesap kurtarma (ADR-0004 §7) kabuk hesabı kapatırken iletişim bilgilerini
 * serbest bırakmak zorunda — kullanıcı aynı e-posta/telefonu kanonik hesabında
 * kullanabilmeli. Koşulsuz kısıt bunu imkânsız kılıyordu (silme işlemi CHECK ihlali
 * üretiyordu).
 *
 * Invariant korunur: aktif/askıda bir hesabın iletişim kanalı olmak zorunda.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users DROP CONSTRAINT users_contact_present;
    ALTER TABLE users ADD CONSTRAINT users_contact_present
      CHECK (status = 'DELETED' OR phone IS NOT NULL OR email IS NOT NULL);
  `);
};

exports.down = (pgm) => {
  // Geri alma yalnızca iletişim bilgisi boş DELETED kayıt yoksa mümkündür; aksi halde
  // kısıt eklenemez ve migration açıkça başarısız olur (sessiz veri kaybı yerine).
  pgm.sql(`
    ALTER TABLE users DROP CONSTRAINT users_contact_present;
    ALTER TABLE users ADD CONSTRAINT users_contact_present
      CHECK (phone IS NOT NULL OR email IS NOT NULL);
  `);
};
