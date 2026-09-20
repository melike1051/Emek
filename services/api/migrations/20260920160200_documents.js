/**
 * Dijital ispat dokümanları (blueprint §14, ADR-0003).
 *
 * Dosyanın kendisi Cloud Storage'da; PostgreSQL yalnızca **metadata + sha256 +
 * storage_key + zaman** tutar. Binary'i veritabanına koymak yedek boyutunu ve
 * transaction maliyetini gereksiz yere büyütürdü.
 *
 * "Dijital ispat" tamper-evident olmak zorundadır: `sha256` ve `storage_key` bir kez
 * yazıldıktan sonra **değiştirilemez** (trigger). Aksi halde önce/sonra fotoğrafı
 * sessizce başka bir nesneyle değiştirilebilir ve kanıt değerini kaybederdi.
 *
 * Nesneler private'tır; erişim yalnızca kısa ömürlü signed URL ile olur (T-12).
 * Public URL veya kalıcı token yoktur.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE document_type AS ENUM (
      'BEFORE_PHOTO',
      'AFTER_PHOTO',
      'SERVICE_NOTE',
      'DISPUTE_EVIDENCE',
      'INVOICE'
    );

    CREATE TYPE document_status AS ENUM ('PENDING_UPLOAD', 'AVAILABLE', 'DELETED');
  `);

  pgm.sql(`
    CREATE TABLE documents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      -- Kanıt dokümanları rezervasyona bağlıdır; fatura gibi bazı tipler bağımsız olabilir.
      booking_id UUID REFERENCES bookings(id) ON DELETE RESTRICT,
      owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      document_type document_type NOT NULL,
      -- Bucket içindeki yol. Tahmin edilebilir olmaması gerekir; servis rastgele üretir.
      storage_key VARCHAR(512) NOT NULL,
      content_type VARCHAR(128) NOT NULL,
      size_bytes BIGINT,
      -- Yüklenen içeriğin bütünlük özeti. Yükleme doğrulanana kadar boştur.
      sha256 CHAR(64),
      status document_status NOT NULL DEFAULT 'PENDING_UPLOAD',
      uploaded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT documents_storage_key_unique UNIQUE (storage_key),
      CHECK (size_bytes IS NULL OR size_bytes > 0),
      CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
      -- Erişilebilir bir doküman mutlaka hash'i ve yükleme zamanıyla birlikte var olur:
      -- hash'siz bir "kanıt" ispat değeri taşımaz.
      CONSTRAINT documents_available_has_hash CHECK (
        status <> 'AVAILABLE' OR (sha256 IS NOT NULL AND uploaded_at IS NOT NULL)
      ),
      -- Rezervasyona bağlı olması gereken kanıt tipleri.
      CONSTRAINT documents_evidence_needs_booking CHECK (
        document_type NOT IN ('BEFORE_PHOTO', 'AFTER_PHOTO', 'SERVICE_NOTE')
        OR booking_id IS NOT NULL
      )
    );

    CREATE INDEX idx_documents_booking ON documents (booking_id, document_type);
    CREATE INDEX idx_documents_owner ON documents (owner_user_id, created_at DESC);

    CREATE TRIGGER documents_set_updated_at
      BEFORE UPDATE ON documents
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  // Bütünlük alanları bir kez yazılır. `sha256` yazıldıktan sonra değişebilse,
  // kanıt zinciri "sonradan uyarlanabilir" olurdu.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION documents_integrity_guard() RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, pg_temp
    AS $$
    BEGIN
      IF OLD.storage_key IS DISTINCT FROM NEW.storage_key THEN
        RAISE EXCEPTION 'documents.storage_key değiştirilemez'
          USING ERRCODE = 'restrict_violation';
      END IF;

      IF OLD.sha256 IS NOT NULL AND NEW.sha256 IS DISTINCT FROM OLD.sha256 THEN
        RAISE EXCEPTION 'documents.sha256 yazıldıktan sonra değiştirilemez'
          USING ERRCODE = 'restrict_violation';
      END IF;

      IF OLD.booking_id IS NOT NULL AND NEW.booking_id IS DISTINCT FROM OLD.booking_id THEN
        RAISE EXCEPTION 'documents.booking_id değiştirilemez'
          USING ERRCODE = 'restrict_violation';
      END IF;

      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER documents_integrity
      BEFORE UPDATE ON documents
      FOR EACH ROW EXECUTE FUNCTION documents_integrity_guard();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS documents_integrity ON documents;
    DROP FUNCTION IF EXISTS documents_integrity_guard();
    DROP TABLE IF EXISTS documents;
    DROP TYPE IF EXISTS document_status;
    DROP TYPE IF EXISTS document_type;
  `);
};
