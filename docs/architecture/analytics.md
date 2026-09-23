# Analytics & BigQuery Pipeline (Faz 11)

Tasarım kararları: [ADR-0021](adr/0021-analytics-bigquery-pipeline.md). Deney:
[EXP-006](../research/experiments/exp-006-analytics-export-reconciliation.md).

## Genel Bakış

```
domain event (outbox) ──▶ AnalyticsExportConsumer (Faz 9) ──▶ analytics_events (PostgreSQL)
                                                                       │
                                                          BigQueryExportService (claim + export)
                                                                       ▼
                                                          BigQuery raw_events (bronze)
                                                                       │
                                                          bigquery/views/*.sql (gold)
```

`analytics_events` Faz 9'da kuruldu ve doldurulmaya başladı; Faz 11 yalnızca onu
BigQuery'ye **export eden** bileşeni ekler. İkinci bir event ingestion mimarisi yoktur.

## Bileşenler

| Bileşen                 | Dosya                                                   | Sorumluluk                                                                               |
| ----------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `BigQueryExportService` | `services/api/src/analytics/bigquery-export.service.ts` | `analytics_events`'i atomik claim eder, BigQuery'ye yazar, `exported_at` işaretler.      |
| `BigQueryExportWorker`  | `services/api/src/analytics/bigquery-export.worker.ts`  | Zamanlanmış tetikleyici (`ANALYTICS_EXPORT_ENABLED`, varsayılan kapalı).                 |
| `BigQueryPort`          | `services/api/src/analytics/bigquery.port.ts`           | Adapter portu (`mock`/`bigquery`, `BIGQUERY_PROVIDER`).                                  |
| `ReconciliationService` | `services/api/src/analytics/reconciliation.service.ts`  | Dahili ödeme tutarlılık taraması (aşağıda).                                              |
| `ReconciliationWorker`  | `services/api/src/analytics/reconciliation.worker.ts`   | Zamanlanmış tetikleyici (`RECONCILIATION_ENABLED`, varsayılan kapalı).                   |
| `AnalyticsController`   | `services/api/src/analytics/analytics.controller.ts`    | `GET /analytics/export/status`, `GET/POST /analytics/reconciliation*` (ADMIN/SUPPORT).   |
| `bigquery/schema.sql`   | `services/api/bigquery/schema.sql`                      | `raw_events` tablo tanımı (partition + cluster).                                         |
| `bigquery/views/*.sql`  | `services/api/bigquery/views/`                          | Metrik view'ları (operasyonel, matching, safety, ESG) — tanım + kaynak lineage başlıkta. |

## Veri modeli

`analytics_events` (PostgreSQL, Faz 9): `event_id` (UNIQUE), `event_type`,
`event_version`, `aggregate_type`, `aggregate_id`, `occurred_at`, `correlation_id`,
`payload` (JSONB, PII yok), `exported_at`, `export_claimed_until` (Faz 11 — claim
kira kolonu).

`raw_events` (BigQuery, bronze): `analytics_events`'in aynı alanlarının kopyası +
`ingested_at` (BigQuery yazım zamanı). `DATE(occurred_at)` ile partition,
`event_type` ile cluster — her metrik sorgusu bir zaman penceresi ve genellikle tek
event tipiyle filtreler.

Metrik view'ları (gold) `raw_events` üzerine kurulur; hiçbiri kendi tablosunu
tutmaz (`CREATE OR REPLACE VIEW`).

## Metrikler ve kaynak lineage

| Alan        | View                                  | Kaynak event tipleri                                 | Durum                                        |
| ----------- | ------------------------------------- | ---------------------------------------------------- | -------------------------------------------- |
| Operasyonel | `operational_daily_funnel`            | BookingCreated/Matched/Confirmed/Completed/Cancelled | ✅                                           |
| Matching    | `matching_daily_by_algorithm_version` | BookingMatched                                       | ✅ (ham skor bileşenleri yok — T-19)         |
| Safety      | `safety_daily_alerts`                 | SafetyAlertRaised                                    | ✅ (yalnızca eşik aşan olaylar — Faz 8 notu) |
| AI/NLP      | —                                     | —                                                    | ❌ event pipeline'ında yok (bkz. ADR-0021)   |
| ESG         | `esg_daily_completed_service_hours`   | ServiceCompleted                                     | ✅                                           |
| ESG         | `esg_daily_safety_incident_rate`      | SafetyAlertRaised, ServiceCompleted                  | ✅                                           |
| ESG         | `esg_monthly_provider_earnings`       | PaymentReleased ⋈ BookingMatched (bookingId)         | ✅                                           |
| ESG         | `esg_monthly_repeat_customer_rate`    | BookingCreated                                       | ✅                                           |
| ESG         | (aktif kadın sağlayıcı sayısı)        | —                                                    | ❌ şemada demografi alanı yok (R-80)         |
| ESG         | (bölgesel erişim)                     | —                                                    | ❌ event payload'ı konum taşımıyor (R-81)    |

## Ödeme mutabakatı

`ReconciliationService` **dış** PSP ekstresiyle karşılaştırmaz (`PaymentProvider`
portunda bu yetenek yok — R-79). Üç dahili tutarlılık kontrolü yapar:

| Tip                               | Koşul                                                             | Env eşiği                                            |
| --------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------- |
| `STUCK_PENDING_COMMAND`           | `payment_commands.status = 'PENDING'` ve eşikten eski             | `RECONCILIATION_STUCK_COMMAND_MINUTES` (15)          |
| `AUTHORIZATION_EXPIRED_UNHANDLED` | `payments.status IN ('AUTHORIZED','HELD')` ve yetki süresi dolmuş | `RECONCILIATION_AUTH_EXPIRY_GRACE_MINUTES` (60)      |
| `RELEASE_PENDING_STALLED`         | `payments.status = 'RELEASE_PENDING'` ve eşikten eski             | `RECONCILIATION_RELEASE_PENDING_GRACE_MINUTES` (120) |

Para hareketi **tetiklemez**. Bulgular `payment_reconciliation_discrepancies`'e
yazılır (aynı ödeme+tip için açık kayıt tekildir — dedup); ADMIN
`POST /analytics/reconciliation/:id/resolve` ile kapatır (audit'li,
`ops/dead-letter` deseniyle aynı).

## Privacy / veri minimizasyonu kararları

- `raw_events.payload` Faz 9'un event zarfı kuralını (PII yok, yalnızca ID
  referansları — event-catalog.md §1) miras alır; Faz 11 bu kurala **yeni bir
  istisna açmaz**.
- `payment_reconciliation_discrepancies.details` yalnızca operasyonel alanlar
  taşır (komut kimliği, işlem tipi, deneme sayısı, zaman damgaları) — tutar,
  kart verisi veya kişi kimliği yok.
- ESG metriklerinden ikisi ("aktif kadın sağlayıcı sayısı", "bölgesel erişim")
  **bilinçli olarak üretilmedi**: gerekli veri (demografi, konum) ya toplanmıyor
  ya da event payload'ında yok. Toplamak yeni bir veri sınıflandırma + KVKK
  kararı gerektirir (R-80, R-81, `TODO(legal)`).
- Sentetik deney verisi (Faz 6/7/8 `docs/research/`) hiçbir event üretmez;
  `raw_events` yalnızca gerçek/test trafiğini içerir — üretim ve sentetik veri
  fiziksel olarak ayrıdır.

## Retention / agregasyon

`analytics_events` (PostgreSQL) için ayrı bir retention job **eklenmedi**: tablo
zaten yalnızca ID referansları ve iş alanları taşıyor (PII yok), bu yüzden Faz 8'in
`location_events` gibi bir "ham veri süresiz saklanmaz" riski taşımıyor. BigQuery
tarafında partition-expiration Terraform ile kurulur (Faz 13) — burada yalnızca
şema (`schema.sql`) IaC artifact'ı olarak versiyonlanır, gerçek dağıtım yapılmaz.

## Bilinen sınırlar (bkz. `docs/research/technical-risks.md`)

- R-79: mutabakat dış PSP'yi görmez.
- R-80: aktif kadın sağlayıcı sayısı ölçülemiyor (demografi verisi yok).
- R-81: bölgesel erişim ölçülemiyor (event payload'ında konum yok).
- AI/NLP metrikleri event pipeline'ından türetilemiyor (parser_version/confidence
  yalnızca `booking_requests` tablosunda).
