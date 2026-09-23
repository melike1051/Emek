/**
 * Faz 12 — hesap kapatma saati ve anonimleştirme izi (R-38, T-24).
 *
 * Faz 3'te `markDeleted` yalnızca `status='DELETED'` yazıp iletişim alanlarını
 * boşaltıyordu. Silme talebinin ne zaman geldiği kayıtlı olmadığı için saklama
 * süresi **uygulanamıyordu**: "30 gün sonra anonimleştir" diyecek bir başlangıç anı
 * yoktu. Bu iki sütun o anı ve sonucu kaydeder.
 *
 * Kayıt **silinmez**, anonimleştirilir: `audit_logs`, `bookings`, `payments` ve
 * `disputes` bu kullanıcıya atıfta bulunur ve bunların saklanması hem mali hem
 * hukuki bir gerekliliktir. Satırı silmek denetim izini ve uyuşmazlık kanıtını
 * birlikte götürürdü. Anonimleştirme, kişiyi tanımlayan alanları kaldırır;
 * referansları korur.
 *
 * TODO(legal): KVKK silme talebinin anonimleştirme ile karşılanıp karşılanmadığı
 * ve mali kayıt saklama yükümlülüğünün süresi hukuk görüşüyle doğrulanacak (A-04).
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users
      ADD COLUMN deleted_at TIMESTAMPTZ,
      ADD COLUMN anonymized_at TIMESTAMPTZ;

    -- Anonimleştirme kapatmadan önce gelemez.
    ALTER TABLE users ADD CONSTRAINT users_anonymized_after_deleted
      CHECK (anonymized_at IS NULL OR deleted_at IS NOT NULL);

    -- Retention işinin tarayacağı küme: kapatılmış ama henüz anonimleştirilmemiş.
    CREATE INDEX idx_users_pending_anonymization ON users (deleted_at)
      WHERE deleted_at IS NOT NULL AND anonymized_at IS NULL;
  `);

  // Faz 3'ten kalan DELETED kayıtlar için başlangıç anı bilinmiyor; en iyi
  // yaklaşım son güncelleme anıdır. Boş bırakmak onları retention dışında
  // bırakırdı — yani hiç anonimleştirilmezlerdi.
  pgm.sql(`
    UPDATE users SET deleted_at = updated_at
      WHERE status = 'DELETED' AND deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  // UYARI: anonimleştirme geri alınamaz. Bu geri alma yalnızca sütunları düşürür;
  // anonimleştirilmiş profil verisi zaten kaybolmuştur.
  pgm.sql(`
    DROP INDEX IF EXISTS idx_users_pending_anonymization;
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_anonymized_after_deleted;
    ALTER TABLE users DROP COLUMN IF EXISTS anonymized_at;
    ALTER TABLE users DROP COLUMN IF EXISTS deleted_at;
  `);
};
