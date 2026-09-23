# ADR-0021 — Analytics/BigQuery Pipeline ve Ödeme Mutabakatı

- Durum: Accepted (2026-09-23)
- Faz: 11
- Blueprint: §5 (Cloud-Native Operations), §17 (Ar-Ge metrikleri)

## Bağlam

Faz 11 kapsamı: event → BigQuery pipeline, operasyonel/matching/safety/AI/ESG metrik
modelleri, ödeme mutabakat işi, dashboard-ready view'lar, retention/agregasyon
(`docs/architecture/phase-plan.md`). PostgreSQL transactional kaynak doğruluk kalır;
BigQuery yalnızca analitiktir. Faz 9, `analytics_events` tablosunu ve onu dolduran
`AnalyticsExportConsumer`'ı zaten kurmuştu (bilinçli olarak Faz 11'e "girdi" bırakılmıştı).

## Karar

1. **İkinci bir ingestion mimarisi kurulmaz.** Faz 9'un `analytics_events` tablosu
   (event zarflarının denormalize kopyası, `exported_at` işaretiyle) tek girdi
   kaynağıdır. Faz 11 yalnızca bunu BigQuery'ye **export eden** bir worker ekler.
2. **Export claim/lease deseni, transaction-içi ağ çağrısı yasağını tekrar eder
   (Faz 7 review bulgusu).** `BigQueryExportService.claimBatch()`
   `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING` ile tek
   ifadede atomik sahiplenir (`export_claimed_until` kira kolonu, `OutboxPublisher`
   ile aynı desen); ağ çağrısı sırasında hiçbir satır kilitli değildir. Kesin
   idempotency `exported_at`'tir; BigQuery `insertId = eventId` ikinci (en iyi
   çaba) bir savunma hattıdır.
3. **BigQuery portu adapter deseniyle soyutlanır** (`BigQueryPort`,
   `PaymentProvider`/`IdentityVerificationProvider` ile aynı desen — ADR-0005/0009).
   `BIGQUERY_PROVIDER=mock` (varsayılan) bellek-içi sahte sağlayıcı; `bigquery`
   gerçek `@google-cloud/bigquery` client'ı. Production'da `ANALYTICS_EXPORT_ENABLED=true`
   iken `BIGQUERY_PROVIDER` zorunlu olarak `bigquery` olmalı (env.schema.ts
   `superRefine`), aksi halde "export ediliyor" iddiası hiçbir yere yazmaz.
4. **BigQuery şeması bronze/gold katmanlıdır.** `raw_events` (bronze, ham event
   kopyası, `DATE(occurred_at)` partition + `event_type` cluster) üzerine metrik
   view'ları (gold, `services/api/bigquery/views/*.sql`) kurulur — ikinci bir
   tablo/pipeline değil, SQL projeksiyonudur. Her view başlığında metrik tanımı ve
   kaynak lineage (hangi event tipi/payload alanı) yazılıdır (research-metrics.md
   kuralı: "metrik tanımı deneyden/koddan önce yazılır").
5. **Ödeme mutabakatı PostgreSQL'de kalır, BigQuery'ye gitmez.** `PaymentProvider`
   portunda dış PSP ekstresi çeken bir yetenek yok (R-79); mutabakat bu yüzden
   **dahili** tutarlılık taramasıdır: `payment_commands`/`payments`'ın kendi içinde
   sürüklenip sürüklenmediğini (yanıtsız komut, işlenmemiş yetki süresi dolumu,
   takılı release) tespit eder. Para hareketi **tetiklemez** — yalnızca
   `payment_reconciliation_discrepancies`'e yazar; Faz 10'un DLQ/notification-jobs
   ops desenindeki gibi ADMIN inceleyip kapatır.
6. **Analitik hata transactional durumu bozamaz.** `BigQueryExportService` ve
   `ReconciliationService` yalnızca kendi tablolarına (`analytics_events`,
   `payment_reconciliation_*`) yazar; hiçbir booking/payment/safety tablosuna
   dokunmaz. BigQuery'ye ulaşılamazsa satır `exported_at = NULL` kalır ve bir
   sonraki turda tekrar denenir — sessizce kaybolmaz, ama booking/payment akışını
   da bloklamaz (ayrı worker, ayrı transaction).
7. **Sentetik/gerçek veri ayrımı:** üretim metrikleri (`raw_events`, gerçek
   trafik) ile Faz 6/7/8'in deney veri setleri (sentetik, `docs/research/`)
   fiziksel olarak farklı kaynaklardadır — sentetik veri hiçbir event yayınlamaz,
   bu yüzden `raw_events`'e hiç girmez. Karışma riski yoktur.

## Alternatifler

- **BigQuery'ye doğrudan streaming (outbox → Pub/Sub → BigQuery subscription):**
  Google Cloud'un yerleşik "BigQuery subscription" özelliği düşünüldü. Reddedildi:
  ikinci bir teslimat garantisi yüzeyi açar (Pub/Sub → BigQuery kendi retry/DLQ
  semantiğini taşır, mevcut `EventConsumerRunner` pipeline'ıyla örtüşür) ve
  `analytics_events`'in zaten var olan idempotency/versiyon kontrolünü by-pass eder.
  Mevcut export worker deseni (`ScheduledReleaseWorker` ailesi) hem daha az
  yüzey hem de zaten test edilmiş bir desendir.
- **Ödeme mutabakatını da BigQuery'de yapmak:** Reddedildi — mutabakat kararının
  kaynağı (payments/payment_commands) zaten PostgreSQL'de; BigQuery'ye
  taşımak yalnızca gecikme (export lag) ekler ve "kesin doğruluk kaynağı
  PostgreSQL'dir" ilkesini (CLAUDE.md §4) zayıflatır.
- **Dış PSP ekstresiyle tam mutabakat:** Şimdilik reddedildi (R-79) — sağlayıcı
  henüz seçilmedi (A-02 doğrulanmadı), port bu yeteneği taşımıyor. Kapsam dahili
  tutarlılığa daraltıldı; dürüstçe ADR'de ve kodda belgelendi.

## Sonuçlar ve Trade-off'lar

- **Basitlik:** İkinci ingestion mimarisi yok; export worker'ın tek işi
  `analytics_events` → BigQuery kopyalamak.
- **Gecikme:** Metrikler gerçek zamanlı değildir — `ANALYTICS_EXPORT_INTERVAL_MS`
  (varsayılan 30 sn) kadar gecikir. Kabul edilebilir: dashboard/rapor kullanım
  senaryosu gerçek zamanlı değildir.
- **AI/NLP metrikleri eksik (bilinen sınır, fabrikasyon değil):** event
  pipeline'ında `parser_version`/`parser_confidence` taşıyan bir event yok
  (yalnızca `booking_requests` tablosunda, ADR-0012 §3); bu yüzden Faz 11
  BigQuery view'ları arasında bir `ai_nlp_metrics.sql` **yoktur**. Ayrı bir karar
  gerektirir (event payload'ını genişletmek mi, Cloud SQL federated query mi) —
  Faz 13 DevOps kapsamına bırakıldı.
- **ESG metriklerinin ikisi eksik (R-80, R-81):** cinsiyet/demografi ve bölge
  verisi şemada yok; uydurulmadı, `esg_metrics.sql` başında açıkça belgelendi.
