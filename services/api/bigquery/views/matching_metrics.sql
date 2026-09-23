-- Matching metrikleri (Faz 11, ADR-0021 §5).
--
-- Metrik tanımı: algoritma sürümü başına günlük eşleştirme hacmi ve ortalama
-- `overallScore` (Faz 7'nin `matching_runs`/`booking_match_results`'ındaki tam
-- skor bileşenleri BURADA yoktur — event payload'ı yalnızca nihai skoru taşır,
-- T-19 gerekçesiyle aynı: ham bileşenler yalnızca ADMIN'e açık iç uçta kalır).
-- Kaynak lineage: raw_events, event_type = 'BookingMatched',
--   payload.algorithmVersion, payload.overallScore.
-- Aggregation window: gün.
CREATE OR REPLACE VIEW `${project}.${dataset}.matching_daily_by_algorithm_version` AS
SELECT
  DATE(occurred_at) AS metric_date,
  JSON_VALUE(payload, '$.algorithmVersion') AS algorithm_version,
  COUNT(*) AS match_count,
  AVG(CAST(JSON_VALUE(payload, '$.overallScore') AS FLOAT64)) AS avg_overall_score
FROM `${project}.${dataset}.raw_events`
WHERE event_type = 'BookingMatched'
GROUP BY metric_date, algorithm_version;
