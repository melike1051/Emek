-- Safety metrikleri (Faz 11, ADR-0021 §5).
--
-- Metrik tanımı: günlük safety alert hacmi, kaynak (`PANIC`/`RULE_ENGINE`) ve
-- şiddet (`severity`) kırılımı. Faz 8'in `safety_risk_assessments` tablosundaki
-- (alarm üretmeyenler dahil TÜM değerlendirmeler) ayrıntısını taşımaz — event
-- yalnızca eşik AŞILDIĞINDA yayınlanır (event-catalog.md §"SafetyAlertRaised").
-- FPR gibi tam oranlar için EXP-004/PostgreSQL kaynağı yetkilidir; bu view
-- yalnızca üretim hacmini/trendini gösterir.
-- Kaynak lineage: raw_events, event_type = 'SafetyAlertRaised',
--   payload.severity, payload.source.
-- Aggregation window: gün.
CREATE OR REPLACE VIEW `${project}.${dataset}.safety_daily_alerts` AS
SELECT
  DATE(occurred_at) AS metric_date,
  JSON_VALUE(payload, '$.severity') AS severity,
  JSON_VALUE(payload, '$.source') AS source,
  COUNT(*) AS alert_count
FROM `${project}.${dataset}.raw_events`
WHERE event_type = 'SafetyAlertRaised'
GROUP BY metric_date, severity, source;
