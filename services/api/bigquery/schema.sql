-- Emek Analytics — BigQuery ham event tablosu (bronze layer)
--
-- Faz 11, ADR-0021. Kaynak: PostgreSQL `analytics_events` (Faz 9 AnalyticsExportConsumer'ın
-- doldurduğu tablo). Bu şema Terraform ile uygulanır (Faz 13); burada IaC artifact'ı olarak
-- versiyonlanır ve `BigQueryClientAdapter`'ın yazdığı satır şekliyle birebir eşleşir.
--
-- Partitioning: DATE(occurred_at) — sorgular her zaman bir zaman penceresiyle filtrelenir
-- (dashboard/metrik tanımları §"Kaynak lineage" bölümüne bakın); partition olmadan her
-- metrik sorgusu tüm event geçmişini tarardı.
-- Clustering: event_type — ikinci en sık filtre/group by alanı (metrik başına tek event tipi
-- ya da küçük bir alt küme okunur).
CREATE TABLE IF NOT EXISTS `${project}.${dataset}.raw_events`
(
  event_id STRING NOT NULL,
  event_type STRING NOT NULL,
  event_version INT64 NOT NULL,
  aggregate_type STRING NOT NULL,
  aggregate_id STRING,
  occurred_at TIMESTAMP NOT NULL,
  correlation_id STRING,
  -- PII taşımaz (event-catalog.md §1) — yalnızca ID referansları ve iş alanları.
  payload JSON NOT NULL,
  ingested_at TIMESTAMP NOT NULL
)
PARTITION BY DATE(occurred_at)
CLUSTER BY event_type
OPTIONS (
  description = 'Faz 9 event zarflarının denormalize kopyası; PostgreSQL analytics_events kaynak doğruluktur.'
);
