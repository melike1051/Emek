-- Operasyonel metrikler (Faz 11, ADR-0021 §5).
--
-- Metrik tanımı: günlük booking hunisi — talep edilen, eşleştirilen, onaylanan,
-- tamamlanan rezervasyon sayısı (event tabanlı sayım, booking_requests/bookings
-- tablolarının kopyası değildir — PostgreSQL'deki gerçek sayım için oradaki
-- tabloya bakılır; bu view yalnızca event akışının gözlemlenebilirliğidir).
-- Kaynak lineage: raw_events, event_type IN
--   ('BookingCreated', 'BookingMatched', 'BookingConfirmed', 'ServiceCompleted', 'BookingCancelled').
-- Aggregation window: gün (DATE(occurred_at)); partition prune ile ucuz sorgu.
CREATE OR REPLACE VIEW `${project}.${dataset}.operational_daily_funnel` AS
SELECT
  DATE(occurred_at) AS metric_date,
  COUNTIF(event_type = 'BookingCreated') AS requested_count,
  COUNTIF(event_type = 'BookingMatched') AS matched_count,
  COUNTIF(event_type = 'BookingConfirmed') AS confirmed_count,
  COUNTIF(event_type = 'ServiceCompleted') AS completed_count,
  COUNTIF(event_type = 'BookingCancelled') AS cancelled_count
FROM `${project}.${dataset}.raw_events`
WHERE event_type IN (
  'BookingCreated', 'BookingMatched', 'BookingConfirmed', 'ServiceCompleted', 'BookingCancelled'
)
GROUP BY metric_date;
