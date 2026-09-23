exports.up = (pgm) => {
  // Dead letter events — failed events that exhausted retries or had permanent failures
  pgm.sql(`
    CREATE TABLE dead_letter_events (
      id BIGSERIAL PRIMARY KEY,
      event_id UUID NOT NULL,
      event_type VARCHAR(80) NOT NULL,
      event_version INTEGER NOT NULL DEFAULT 1,
      consumer VARCHAR(80) NOT NULL,
      payload JSONB NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 1,
      failure_classification VARCHAR(20) NOT NULL CHECK (failure_classification IN ('TRANSIENT', 'PERMANENT')),
      failure_reason VARCHAR(500) NOT NULL,
      first_failure_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_failure_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (attempt_count > 0),
      CHECK (last_failure_at >= first_failure_at)
    );

    CREATE INDEX idx_dead_letter_unresolved ON dead_letter_events (consumer, created_at)
      WHERE resolved_at IS NULL;
    CREATE UNIQUE INDEX idx_dead_letter_event ON dead_letter_events (event_id, consumer)
      WHERE resolved_at IS NULL;
  `);

  // Notification jobs — downstream of event consumers
  pgm.sql(`
    CREATE TYPE notification_channel AS ENUM ('PUSH', 'SMS', 'EMAIL', 'IN_APP');
    CREATE TYPE notification_job_status AS ENUM ('PENDING', 'SENT', 'FAILED');

    CREATE TABLE notification_jobs (
      id BIGSERIAL PRIMARY KEY,
      event_id UUID NOT NULL,
      event_type VARCHAR(80) NOT NULL,
      channel notification_channel NOT NULL DEFAULT 'IN_APP',
      recipient_user_id UUID NOT NULL,
      template_key VARCHAR(120) NOT NULL,
      template_data JSONB NOT NULL DEFAULT '{}',
      status notification_job_status NOT NULL DEFAULT 'PENDING',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error VARCHAR(200),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      sent_at TIMESTAMPTZ,
      UNIQUE (event_id, channel, recipient_user_id)
    );

    CREATE INDEX idx_notification_pending ON notification_jobs (created_at)
      WHERE status = 'PENDING';
  `);

  // Analytics events — denormalized event records for Phase 11 BigQuery export
  pgm.sql(`
    CREATE TABLE analytics_events (
      id BIGSERIAL PRIMARY KEY,
      event_id UUID NOT NULL UNIQUE,
      event_type VARCHAR(80) NOT NULL,
      event_version INTEGER NOT NULL DEFAULT 1,
      aggregate_type VARCHAR(80) NOT NULL,
      aggregate_id UUID,
      occurred_at TIMESTAMPTZ NOT NULL,
      correlation_id UUID,
      payload JSONB NOT NULL,
      exported_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_analytics_unexported ON analytics_events (created_at)
      WHERE exported_at IS NULL;
    CREATE INDEX idx_analytics_type_date ON analytics_events (event_type, occurred_at);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS analytics_events;
    DROP TABLE IF EXISTS notification_jobs;
    DROP TYPE IF EXISTS notification_job_status;
    DROP TYPE IF EXISTS notification_channel;
    DROP TABLE IF EXISTS dead_letter_events;
  `);
};
