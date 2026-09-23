# BigQuery analytics (ADR-0021, R-83).
#
# BigQuery **analitik hedeftir**, doğruluğun kaynağı değil: PostgreSQL'deki
# `analytics_events` kanonik kopyadır ve export tek yönlüdür.

resource "google_bigquery_dataset" "analytics" {
  project    = var.project_id
  dataset_id = "emek_analytics"
  location   = var.region
  labels     = local.labels

  description = "Emek operasyonel/AI/ESG metrikleri — ham event katmanı ve türetilmiş view'lar."

  # R-83: dataset seviyesinde varsayılan partition ömrü. 0 verilirse süresizdir —
  # bu bilinçli bir karar olmalı, varsayılan değil.
  default_partition_expiration_ms = var.analytics_table_expiration_days > 0 ? var.analytics_table_expiration_days * 24 * 60 * 60 * 1000 : null

  delete_contents_on_destroy = false
}

# Ham event tablosu (bronze). Şema `services/api/src/analytics/bigquery-client.adapter.ts`
# ile aynı olmak zorundadır: adapter `raw: true` ile yazar ve bilinmeyen alanları
# reddeder (`ignoreUnknownValues: false`), yani ayrışma sessiz kalmaz — export düşer.
resource "google_bigquery_table" "raw_events" {
  project    = var.project_id
  dataset_id = google_bigquery_dataset.analytics.dataset_id
  table_id   = "raw_events"
  labels     = local.labels

  # Silme koruması: analitik geçmiş yeniden üretilemez (PostgreSQL kopyası retention
  # ile siliniyor — RETENTION_ANALYTICS_EVENT_DAYS).
  deletion_protection = var.deletion_protection

  time_partitioning {
    type          = "DAY"
    field         = "occurred_at"
    expiration_ms = var.analytics_table_expiration_days > 0 ? var.analytics_table_expiration_days * 24 * 60 * 60 * 1000 : null
  }

  clustering = ["event_type"]

  schema = jsonencode([
    { name = "event_id", type = "STRING", mode = "REQUIRED" },
    { name = "event_type", type = "STRING", mode = "REQUIRED" },
    { name = "event_version", type = "INTEGER", mode = "REQUIRED" },
    { name = "aggregate_type", type = "STRING", mode = "REQUIRED" },
    { name = "aggregate_id", type = "STRING", mode = "NULLABLE" },
    { name = "occurred_at", type = "TIMESTAMP", mode = "REQUIRED" },
    { name = "correlation_id", type = "STRING", mode = "NULLABLE" },
    # Event payload'ları PII taşımaz (event-catalog.md §1); yalnızca kimlik referansları.
    { name = "payload", type = "JSON", mode = "NULLABLE" },
    { name = "ingested_at", type = "TIMESTAMP", mode = "REQUIRED" },
  ])
}
