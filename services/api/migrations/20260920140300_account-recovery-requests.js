/**
 * Hesap kurtarma talepleri (ADR-0004 §7 — Faz 3 güvenlik düzeltmesi).
 *
 * İlk uygulamada kimlik eşleşmesi kurtarmayı **otomatik** tamamlıyordu. Bu bir hesap
 * devralma yoluydu: kurtarma oturumunu saldırgan başlatır, oturum bağlantısını mağdura
 * ulaştırır ("kimliğinizi doğrulayın") ve mağdur kendi belgesiyle gerçek, yüksek güvenceli
 * bir doğrulama yapar. Kimlik eşleşmesi mağduru gösterir, oturum ise saldırgana aittir —
 * sonuçta saldırganın oturum kimliği mağdurun hesabına taşınırdı.
 *
 * Güvence seviyesi, belgeyi sunanın canlı olduğunu kanıtlar; **oturumu başlatanın kim
 * olduğunu kanıtlamaz.** Bu yüzden kimlik eşleşmesi artık kurtarmayı tamamlamaz, yalnızca
 * incelemeye açılan bir talep oluşturur. Taleplerin onayı operatör aksiyonudur (Faz 10
 * admin API'si) ve tamamen audit'lidir.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE recovery_request_status AS ENUM ('PENDING_REVIEW','APPROVED','REJECTED');
  `);

  pgm.sql(`
    CREATE TABLE account_recovery_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      -- Talebi başlatan (kimliği doğrulanan oturumun sahibi) hesap.
      requester_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      -- Kimliğin ait olduğu kanonik hesap.
      target_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      verification_attempt_id UUID NOT NULL REFERENCES verification_attempts(id) ON DELETE RESTRICT,
      status recovery_request_status NOT NULL DEFAULT 'PENDING_REVIEW',
      assurance_level assurance_level NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      decided_at TIMESTAMPTZ,
      decided_by UUID REFERENCES users(id),
      decision_reason VARCHAR(160),
      -- Kendi hesabını "kurtarmak" anlamsızdır ve kontrolü karmaşıklaştırır.
      CHECK (requester_user_id <> target_user_id),
      CHECK ((status = 'PENDING_REVIEW') = (decided_at IS NULL)),
      CHECK ((decided_at IS NULL) OR (decided_by IS NOT NULL)),
      -- Bir doğrulama denemesi tek talep üretir (callback replay yeni talep açmaz).
      UNIQUE (verification_attempt_id)
    );

    -- Aynı hedef hesap için birden fazla bekleyen talep olmaz: operatör tek bir kararla
    -- karşılaşır ve paralel taleplerle zorlama (talep seli) yolu kapanır.
    CREATE UNIQUE INDEX uq_recovery_pending_per_target
      ON account_recovery_requests (target_user_id) WHERE status = 'PENDING_REVIEW';

    CREATE INDEX idx_recovery_requests_requester
      ON account_recovery_requests (requester_user_id, created_at DESC);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS account_recovery_requests;
    DROP TYPE IF EXISTS recovery_request_status;
  `);
};
