/**
 * `audit_logs` — kritik işlemlerin değiştirilemez kaydı (ADR-0013).
 *
 * İki savunma katmanı:
 *
 * 1. **Değişmezlik trigger'ı:** UPDATE/DELETE her rol için reddedilir. Bu, yetkiye
 *    dayalı korumadan daha geniştir (bağlantı hangi rolle açılırsa açılsın geçerlidir)
 *    ve Cloud SQL rolleri Terraform ile sağlanana kadar (Faz 13) tek gerçek korumadır.
 * 2. **Hash zinciri:** her satır kendinden önceki satırın hash'ini taşır. Ayrıcalıklı
 *    bir erişim (superuser, migration rolü) trigger'ı düşürüp geçmişi yeniden yazsa
 *    bile zincir kopar ve `audit_chain_broken_at()` bunu tespit eder.
 *    Zincir tamper-**evident**'tır, tamper-proof değildir.
 *
 * Satır hash'i ve zincir veritabanında hesaplanır: uygulama katmanının bunu unutması
 * veya yanlış hesaplaması mümkün olmamalı.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE audit_logs (
      id BIGSERIAL PRIMARY KEY,
      -- Bilinçli olarak FOREIGN KEY YOK: audit kaydı değişmezdir (UPDATE/DELETE trigger ile
      -- engellenir), bu yüzden ON DELETE SET NULL/CASCADE uygulanamaz. FK NO ACTION olarak
      -- kalsaydı denetlenmiş bir kullanıcı hiç silinemez ve KVKK silme talebi (Faz 12)
      -- teknik olarak imkânsız olurdu. Referans "soft"tur: kullanıcı silinse bile
      -- tarihsel kayıt kimin işlem yaptığını göstermeye devam eder.
      actor_user_id UUID,
      action VARCHAR(100) NOT NULL,
      entity_type VARCHAR(80) NOT NULL,
      entity_id UUID,
      old_value JSONB,
      new_value JSONB,
      ip_address INET,
      request_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      prev_hash CHAR(64),
      hash CHAR(64) NOT NULL
    );

    CREATE INDEX idx_audit_logs_entity ON audit_logs (entity_type, entity_id, id DESC);
    CREATE INDEX idx_audit_logs_actor ON audit_logs (actor_user_id, id DESC);
    CREATE INDEX idx_audit_logs_action ON audit_logs (action, id DESC);
  `);

  // Zincir hesaplama.
  //
  // DİKKAT: kilit burada alınmaz. `id` (BIGSERIAL) tuple oluşturulurken, yani BEFORE
  // INSERT trigger'ı çalışmadan ÖNCE atanır. Kilidi trigger içinde almak, id sırası ile
  // zincir sırasının ayrışmasına izin verir: A id=5 alır, B id=6 alır, B önce zincirler
  // (prev=4), sonra A kendini B'nin üstüne zincirler → `ORDER BY id` ile yürüyen doğrulama
  // 5. satırı "bozuk" sanır. Bu yüzden sıralamayı uygulama katmanı garanti eder:
  // AuditService.record(), INSERT'ten önce aynı transaction'da advisory lock alır.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION audit_logs_chain() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, public, pg_temp
    AS $$
    DECLARE
      previous_hash CHAR(64);
      payload TEXT;
    BEGIN
      SELECT a.hash INTO previous_hash FROM audit_logs a ORDER BY a.id DESC LIMIT 1;

      -- created_at::text oturumun TimeZone/DateStyle ayarına bağlıdır: farklı ayarla
      -- bağlanan bir doğrulama işi aynı satır için farklı hash hesaplar ve zincir
      -- "bozuk" görünür. Bu yüzden UTC'ye sabitlenmiş, deterministik biçim kullanılır.
      payload := concat_ws(
        '|',
        NEW.id::text,
        coalesce(NEW.actor_user_id::text, ''),
        NEW.action,
        NEW.entity_type,
        coalesce(NEW.entity_id::text, ''),
        coalesce(NEW.old_value::text, ''),
        coalesce(NEW.new_value::text, ''),
        coalesce(host(NEW.ip_address), ''),
        coalesce(NEW.request_id::text, ''),
        to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
      );

      NEW.prev_hash := previous_hash;
      NEW.hash := encode(digest(coalesce(previous_hash, '') || payload, 'sha256'), 'hex');
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER audit_logs_set_chain
      BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION audit_logs_chain();
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, pg_temp
    AS $$
    BEGIN
      RAISE EXCEPTION 'audit_logs append-only: % engellendi', TG_OP
        USING ERRCODE = 'restrict_violation';
    END;
    $$;

    CREATE TRIGGER audit_logs_no_update
      BEFORE UPDATE OR DELETE ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

    CREATE TRIGGER audit_logs_no_truncate
      BEFORE TRUNCATE ON audit_logs
      FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();
  `);

  // Kısmi yetki savunması: PUBLIC rolünden değiştirme yetkileri alınır. Tam rol ayrımı
  // (uygulamaya ayrı, migration'dan farklı bir DB kullanıcısı) Cloud SQL kullanıcılarının
  // Terraform ile sağlandığı Faz 13'te yapılır (ADR-0013 uygulama notu).
  pgm.sql(`
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM PUBLIC;
  `);

  // Zincir doğrulama: ilk bozuk satırın id'sini döner, zincir sağlamsa NULL.
  // Operasyonel doğrulama işi ve alarmı Faz 12'de bu fonksiyonu kullanır.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION audit_chain_broken_at() RETURNS BIGINT
      LANGUAGE plpgsql
      STABLE
      SET search_path = pg_catalog, public, pg_temp
    AS $$
    DECLARE
      row_record RECORD;
      expected_prev CHAR(64) := NULL;
      expected_hash CHAR(64);
      payload TEXT;
    BEGIN
      FOR row_record IN SELECT * FROM audit_logs ORDER BY id LOOP
        payload := concat_ws(
          '|',
          row_record.id::text,
          coalesce(row_record.actor_user_id::text, ''),
          row_record.action,
          row_record.entity_type,
          coalesce(row_record.entity_id::text, ''),
          coalesce(row_record.old_value::text, ''),
          coalesce(row_record.new_value::text, ''),
          coalesce(host(row_record.ip_address), ''),
          coalesce(row_record.request_id::text, ''),
          to_char(row_record.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
        );
        expected_hash := encode(digest(coalesce(expected_prev, '') || payload, 'sha256'), 'hex');

        IF row_record.prev_hash IS DISTINCT FROM expected_prev
           OR row_record.hash IS DISTINCT FROM expected_hash THEN
          RETURN row_record.id;
        END IF;

        expected_prev := row_record.hash;
      END LOOP;

      RETURN NULL;
    END;
    $$;
  `);
};

exports.down = (pgm) => {
  // UYARI: bu geri alma denetim izini **siler**. Üretimde audit'in gerçek kopyası,
  // ADR-0013 §8'deki retention-locked dışa aktarımdır; bu migration'ı üretimde geri
  // almak yalnızca o kopya doğrulandıktan sonra düşünülebilir.
  pgm.sql(`
    DROP FUNCTION IF EXISTS audit_chain_broken_at();
    DROP TRIGGER IF EXISTS audit_logs_no_truncate ON audit_logs;
    DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs;
    DROP TRIGGER IF EXISTS audit_logs_set_chain ON audit_logs;
    DROP FUNCTION IF EXISTS audit_logs_immutable();
    DROP FUNCTION IF EXISTS audit_logs_chain();
    DROP TABLE IF EXISTS audit_logs;
  `);
};
