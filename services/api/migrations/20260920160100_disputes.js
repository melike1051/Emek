/**
 * Uyuşmazlık (dispute) kayıtları — ADR-0006 §6, ADR-0009 §9.
 *
 * Dispute, ödemenin serbest bırakılmasını **bloklayan** bir gerçektir. Bu yüzden
 * "açık dispute var mı?" sorusu tek bir index'lenmiş sorguyla yanıtlanabilmeli;
 * booking durumundan türetilen bir tahmin yeterli değildir (booking `DISPUTED`
 * durumuna geçmeden de dispute açılabilir, kararı operatör verir).
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE dispute_status AS ENUM (
      'OPEN',
      'UNDER_REVIEW',
      'RESOLVED_CUSTOMER',
      'RESOLVED_PROVIDER',
      'WITHDRAWN'
    );

    CREATE TYPE dispute_reason AS ENUM (
      'SERVICE_NOT_PERFORMED',
      'SERVICE_QUALITY',
      'DAMAGE',
      'BILLING',
      'SAFETY',
      'OTHER'
    );
  `);

  pgm.sql(`
    CREATE TABLE disputes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
      -- Açan taraf silinse bile uyuşmazlık kaydı durur: finansal karar geçmişi silinmez.
      opened_by UUID REFERENCES users(id) ON DELETE SET NULL,
      reason dispute_reason NOT NULL,
      description VARCHAR(2000),
      status dispute_status NOT NULL DEFAULT 'OPEN',
      resolution VARCHAR(2000),
      resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
      resolved_at TIMESTAMPTZ,
      -- Kısmi iade kararı: karar anında ne kadar iade edileceği kaydedilir.
      refund_amount_minor BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

      CHECK (refund_amount_minor IS NULL OR refund_amount_minor >= 0),
      -- Karara bağlanmış bir uyuşmazlığın kim ve ne zaman karar verdiği bilinmek
      -- zorundadır; "çözüldü ama kimse karar vermedi" bir denetim boşluğudur.
      CONSTRAINT disputes_resolution_complete CHECK (
        status IN ('OPEN', 'UNDER_REVIEW')
        OR (resolved_at IS NOT NULL AND resolution IS NOT NULL)
      ),
      CONSTRAINT disputes_open_has_no_resolution CHECK (
        status NOT IN ('OPEN', 'UNDER_REVIEW')
        OR (resolved_at IS NULL AND resolved_by IS NULL)
      )
    );
  `);

  // Aynı rezervasyon için aynı anda yalnızca bir **açık** uyuşmazlık olabilir:
  // ikinci bir açık kayıt, hangisinin release'i bloklandığını belirsizleştirirdi.
  // Kapanmış uyuşmazlıklar sınırsızdır (aynı rezervasyon için yeni bir konu açılabilir).
  pgm.sql(`
    CREATE UNIQUE INDEX uq_disputes_open_per_booking
      ON disputes (booking_id)
      WHERE status IN ('OPEN', 'UNDER_REVIEW');

    CREATE INDEX idx_disputes_status ON disputes (status, created_at DESC);

    CREATE TRIGGER disputes_set_updated_at
      BEFORE UPDATE ON disputes
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS disputes;
    DROP TYPE IF EXISTS dispute_reason;
    DROP TYPE IF EXISTS dispute_status;
  `);
};
