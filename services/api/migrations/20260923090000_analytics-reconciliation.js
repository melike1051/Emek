exports.up = (pgm) => {
  // BigQuery export claim/lease kolonu (Faz 11, ADR-0021).
  //
  // Faz 7 review bulgusu tekrarlanmasın diye (AI çağrısı transaction içindeydi, satır
  // kilidini 10 sn boyunca tutuyordu — matching.md): export worker satırı bir
  // `FOR UPDATE SKIP LOCKED` transaction'ı içinde **kilitli tutarak** BigQuery'ye
  // yazmaz. Bunun yerine OutboxPublisher'daki gibi tek ifadelik atomik
  // sahiplenme kullanılır: `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)
  // RETURNING`. Kilit ifade bitince bırakılır; ağ çağrısı sırasında hiçbir satır
  // kilitli değildir. Kira süresi dolan (worker çöktü) satırlar kendiliğinden
  // yeniden sahiplenilebilir olur.
  // Var olan `idx_analytics_unexported (created_at) WHERE exported_at IS NULL`
  // (Faz 9) claim sorgusunun `ORDER BY created_at, id` yürüyüşünü zaten karşılıyor;
  // ikinci bir index gereksiz (CLAUDE.md §5 "gereksiz abstraction").
  pgm.sql(`
    ALTER TABLE analytics_events ADD COLUMN export_claimed_until TIMESTAMPTZ;
  `);

  // Ödeme mutabakatı (Faz 11): `payment_commands`/`payment_events`/`payments` üzerinde
  // dahili tutarlılık taraması. Dış PSP ekstresiyle karşılaştırma yok — `PaymentProvider`
  // portunda işlem listesi çeken bir yetenek yok (ADR-0021 §3); bu yüzden kapsam, komut
  // defteri ile gerçekleşen durumun kendi içinde sürüklenip sürüklenmediğini (stuck
  // command, işlenmemiş süre dolumu, takılı release) tespit etmekle sınırlıdır.
  // Para hareketi tetiklemez, yalnızca operatöre görünürlük sağlar (ops/dead-letter deseni).
  pgm.sql(`
    CREATE TABLE payment_reconciliation_runs (
      id BIGSERIAL PRIMARY KEY,
      triggered_by VARCHAR(20) NOT NULL CHECK (triggered_by IN ('SCHEDULED', 'MANUAL')),
      status VARCHAR(20) NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
      checked_count INTEGER NOT NULL DEFAULT 0,
      discrepancy_count INTEGER NOT NULL DEFAULT 0,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,

      CHECK (checked_count >= 0 AND discrepancy_count >= 0),
      -- Bitmemiş bir tur bitiş zamanı taşıyamaz; RUNNING dışı her tur ne zaman
      -- bittiğini bilmek zorundadır (aksi halde "asılı mı, bitti mi" ayrımı kaybolur).
      CONSTRAINT reconciliation_runs_finished_consistent CHECK (
        (status = 'RUNNING') = (finished_at IS NULL)
      )
    );

    CREATE INDEX idx_reconciliation_runs_started ON payment_reconciliation_runs (started_at DESC);

    CREATE TABLE payment_reconciliation_discrepancies (
      id BIGSERIAL PRIMARY KEY,
      run_id BIGINT NOT NULL REFERENCES payment_reconciliation_runs(id) ON DELETE RESTRICT,
      payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
      discrepancy_type VARCHAR(40) NOT NULL CHECK (discrepancy_type IN (
        'STUCK_PENDING_COMMAND',
        'AUTHORIZATION_EXPIRED_UNHANDLED',
        'RELEASE_PENDING_STALLED'
      )),
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ,
      resolved_by UUID REFERENCES users(id) ON DELETE RESTRICT,

      CONSTRAINT reconciliation_discrepancies_resolved_consistent CHECK (
        (resolved_at IS NULL) = (resolved_by IS NULL)
      )
    );

    -- Aynı ödeme + tip için açık (çözülmemiş) tek bulgu: her tur aynı sorunu yeniden
    -- yazmak yerine mevcut açık kaydı korur (dead_letter_events ile aynı desen).
    CREATE UNIQUE INDEX idx_reconciliation_open_unique
      ON payment_reconciliation_discrepancies (payment_id, discrepancy_type)
      WHERE resolved_at IS NULL;
    CREATE INDEX idx_reconciliation_unresolved
      ON payment_reconciliation_discrepancies (detected_at)
      WHERE resolved_at IS NULL;
    CREATE INDEX idx_reconciliation_by_run
      ON payment_reconciliation_discrepancies (run_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS payment_reconciliation_discrepancies;
    DROP TABLE IF EXISTS payment_reconciliation_runs;
    ALTER TABLE analytics_events DROP COLUMN IF EXISTS export_claimed_until;
  `);
};
