-- ESG / etki metrikleri (Faz 11, ADR-0021 §5, research-metrics.md §6).
--
-- research-metrics.md §6 altı ESG metriği listeler. Bunlardan **dördü** mevcut event
-- pipeline'ından türetilebilir (aşağıda). **İki tanesi türetilemez** ve bilinçli olarak
-- burada yoktur (uydurulmadı — R-80, R-81, docs/research/technical-risks.md):
--   - "Aktif kadın sağlayıcı sayısı": şemada hiçbir yerde cinsiyet/demografi alanı yok.
--     Toplanacaksa TODO(legal): KVKK'ya uygunluk ve veri minimizasyonu gerekçesi önce
--     yazılmalı (CLAUDE.md §5 "Yasaklar").
--   - "Bölgesel erişim": adres/bölge bilgisi yalnızca PostgreSQL `addresses`'te var,
--     hiçbir event payload'ı taşımıyor (event-catalog.md — bilinçli, konum PII'dir).

-- 1) Tamamlanan hizmet saati.
-- Kaynak lineage: raw_events, event_type = 'ServiceCompleted', payload.durationMinutes.
CREATE OR REPLACE VIEW `${project}.${dataset}.esg_daily_completed_service_hours` AS
SELECT
  DATE(occurred_at) AS metric_date,
  SUM(CAST(JSON_VALUE(payload, '$.durationMinutes') AS FLOAT64)) / 60 AS completed_service_hours
FROM `${project}.${dataset}.raw_events`
WHERE event_type = 'ServiceCompleted'
GROUP BY metric_date;

-- 2) Güvenlik olayı oranı: SafetyAlertRaised / ServiceCompleted (aynı gün).
-- Kaynak lineage: raw_events, event_type IN ('SafetyAlertRaised', 'ServiceCompleted').
CREATE OR REPLACE VIEW `${project}.${dataset}.esg_daily_safety_incident_rate` AS
SELECT
  DATE(occurred_at) AS metric_date,
  COUNTIF(event_type = 'SafetyAlertRaised') AS safety_alert_count,
  COUNTIF(event_type = 'ServiceCompleted') AS completed_service_count,
  SAFE_DIVIDE(
    COUNTIF(event_type = 'SafetyAlertRaised'),
    COUNTIF(event_type = 'ServiceCompleted')
  ) AS safety_incident_rate
FROM `${project}.${dataset}.raw_events`
WHERE event_type IN ('SafetyAlertRaised', 'ServiceCompleted')
GROUP BY metric_date;

-- 3) Sağlayıcı başına kazanç dağılımı (aylık): PaymentReleased'i bookingId üzerinden
--    BookingMatched ile eşleştirip providerId çıkarır — PaymentReleased'in kendisi
--    providerId taşımaz (event-catalog.md).
-- Kaynak lineage: raw_events, event_type IN ('PaymentReleased', 'BookingMatched'),
--   payload.bookingId (join key), payload.amountMinor, payload.providerId.
CREATE OR REPLACE VIEW `${project}.${dataset}.esg_monthly_provider_earnings` AS
WITH released AS (
  SELECT
    DATE_TRUNC(DATE(occurred_at), MONTH) AS metric_month,
    JSON_VALUE(payload, '$.bookingId') AS booking_id,
    CAST(JSON_VALUE(payload, '$.amountMinor') AS INT64) AS amount_minor
  FROM `${project}.${dataset}.raw_events`
  WHERE event_type = 'PaymentReleased'
),
matched AS (
  SELECT
    JSON_VALUE(payload, '$.bookingId') AS booking_id,
    JSON_VALUE(payload, '$.providerId') AS provider_id
  FROM `${project}.${dataset}.raw_events`
  WHERE event_type = 'BookingMatched'
)
SELECT
  released.metric_month,
  matched.provider_id,
  SUM(released.amount_minor) AS total_released_minor,
  COUNT(*) AS released_payment_count
FROM released
JOIN matched USING (booking_id)
GROUP BY metric_month, matched.provider_id;

-- 4) Tekrar müşteri oranı (aylık): aynı ay içinde birden fazla BookingCreated
--    üreten müşterilerin oranı.
-- Kaynak lineage: raw_events, event_type = 'BookingCreated', payload.customerId.
CREATE OR REPLACE VIEW `${project}.${dataset}.esg_monthly_repeat_customer_rate` AS
WITH per_customer AS (
  SELECT
    DATE_TRUNC(DATE(occurred_at), MONTH) AS metric_month,
    JSON_VALUE(payload, '$.customerId') AS customer_id,
    COUNT(*) AS booking_count
  FROM `${project}.${dataset}.raw_events`
  WHERE event_type = 'BookingCreated'
  GROUP BY metric_month, customer_id
)
SELECT
  metric_month,
  COUNT(*) AS distinct_customer_count,
  COUNTIF(booking_count > 1) AS repeat_customer_count,
  SAFE_DIVIDE(COUNTIF(booking_count > 1), COUNT(*)) AS repeat_customer_rate
FROM per_customer
GROUP BY metric_month;
