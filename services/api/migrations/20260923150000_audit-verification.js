/**
 * Faz 12 — audit hash zinciri doğrulama durumu ve retention-locked dışa aktarım
 * (ADR-0013 §8, ADR-0022).
 *
 * `audit_chain_broken_at()` (Faz 2) tüm tabloyu baştan tarar. Bu, zincir büyüdükçe
 * saatlik bir iş için uygun değildir. Buradaki iki tablo artımlı doğrulamayı
 * mümkün kılar:
 *
 * - `audit_chain_checkpoints`: en son **doğrulanmış** satır ve onun hash'i. Bir
 *   sonraki tur buradan devam eder; checkpoint'in kendi hash'i beklenen `prev_hash`
 *   olarak kullanılır, böylece "doğrulanmış" geçmiş yeniden yazılırsa da fark edilir.
 * - `audit_exports`: değişmez depolamaya yazılan zincir parçalarının kaydı
 *   (aralık + parça özeti + storage_key). Veritabanı tamamen ele geçirilse bile
 *   dışa aktarılmış parçanın özeti bağımsız kopyayla karşılaştırılabilir.
 *
 * İki tablo da doğrulamayı **gözlemler**, audit satırlarına dokunmaz: doğrulama
 * tarihsel kaydı değiştiremez (append-only trigger zaten buna izin vermez).
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE audit_chain_checkpoints (
      id BIGSERIAL PRIMARY KEY,
      -- Doğrulanmış son satırın id'si ve hash'i.
      verified_through_id BIGINT NOT NULL,
      verified_hash CHAR(64) NOT NULL,
      -- Bu turda doğrulanan satır sayısı (gözlemlenebilirlik).
      rows_verified INTEGER NOT NULL CHECK (rows_verified >= 0),
      -- Kopukluk bulunduysa ilk bozuk satırın id'si; sağlamsa NULL.
      broken_at_id BIGINT,
      status VARCHAR(16) NOT NULL CHECK (status IN ('OK', 'BROKEN')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT audit_checkpoint_broken_consistent
        CHECK ((status = 'BROKEN') = (broken_at_id IS NOT NULL))
    );

    CREATE INDEX idx_audit_checkpoints_recent ON audit_chain_checkpoints (id DESC);

    -- Doğrulama geçmişi de kanıttır: sonradan "hep OK'ti" diye düzeltilememeli.
    CREATE TRIGGER audit_chain_checkpoints_no_update
      BEFORE UPDATE OR DELETE ON audit_chain_checkpoints
      FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

    REVOKE UPDATE, DELETE, TRUNCATE ON audit_chain_checkpoints FROM PUBLIC;
  `);

  pgm.sql(`
    CREATE TABLE audit_exports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      from_audit_id BIGINT NOT NULL,
      through_audit_id BIGINT NOT NULL,
      row_count INTEGER NOT NULL CHECK (row_count > 0),
      -- Dışa aktarılan parçanın içerik özeti. Bağımsız kopyayla karşılaştırma noktası.
      sha256 CHAR(64) NOT NULL,
      -- Değişmez (retention-locked) depolamadaki nesne anahtarı.
      storage_key TEXT NOT NULL UNIQUE,
      -- Nesnenin silinemeyeceği en erken an; Faz 13'te bucket retention policy ile eşleşir.
      retention_until TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT audit_exports_range CHECK (through_audit_id >= from_audit_id)
    );

    CREATE INDEX idx_audit_exports_range ON audit_exports (through_audit_id DESC);

    CREATE TRIGGER audit_exports_no_update
      BEFORE UPDATE OR DELETE ON audit_exports
      FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

    REVOKE UPDATE, DELETE, TRUNCATE ON audit_exports FROM PUBLIC;
  `);

  /**
   * Artımlı zincir doğrulaması.
   *
   * `p_from_id`'den başlayarak en fazla `p_limit` satırı, `p_expected_prev`
   * beklenen önceki hash'iyle yürür. Dönen kayıt: son doğrulanan id/hash, satır
   * sayısı ve varsa ilk bozuk satır.
   *
   * Hash payload'ı `audit_logs_chain()` ile **birebir aynıdır**; ikisi ayrışırsa
   * doğrulama sağlam bir zinciri bozuk sanar.
   */
  pgm.sql(`
    CREATE OR REPLACE FUNCTION audit_chain_verify_range(
      p_from_id BIGINT,
      p_expected_prev CHAR(64),
      p_limit INTEGER
    ) RETURNS TABLE (
      last_verified_id BIGINT,
      last_verified_hash CHAR(64),
      rows_verified INTEGER,
      broken_at_id BIGINT
    )
      LANGUAGE plpgsql
      STABLE
      SET search_path = pg_catalog, public, pg_temp
    AS $$
    DECLARE
      row_record RECORD;
      expected_prev CHAR(64) := p_expected_prev;
      expected_hash CHAR(64);
      payload TEXT;
      counted INTEGER := 0;
      last_id BIGINT := NULL;
    BEGIN
      FOR row_record IN
        SELECT * FROM audit_logs WHERE id >= p_from_id ORDER BY id LIMIT p_limit
      LOOP
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
          last_verified_id := last_id;
          last_verified_hash := expected_prev;
          rows_verified := counted;
          broken_at_id := row_record.id;
          RETURN NEXT;
          RETURN;
        END IF;

        expected_prev := row_record.hash;
        last_id := row_record.id;
        counted := counted + 1;
      END LOOP;

      last_verified_id := last_id;
      last_verified_hash := expected_prev;
      rows_verified := counted;
      broken_at_id := NULL;
      RETURN NEXT;
    END;
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP FUNCTION IF EXISTS audit_chain_verify_range(BIGINT, CHAR, INTEGER);
    DROP TRIGGER IF EXISTS audit_exports_no_update ON audit_exports;
    DROP TABLE IF EXISTS audit_exports;
    DROP TRIGGER IF EXISTS audit_chain_checkpoints_no_update ON audit_chain_checkpoints;
    DROP TABLE IF EXISTS audit_chain_checkpoints;
  `);
};
