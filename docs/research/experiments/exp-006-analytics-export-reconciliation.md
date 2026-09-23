# EXP-006: Analytics Export & Payment Reconciliation

- Tarih: 2026-09-23
- Faz: 11

## Hipotez

BigQuery export worker'ı (claim/lease + `exported_at` işareti) `analytics_events`'teki
her satırı **tam olarak bir kez** BigQuery'ye taşır — kaybetmez, tekrarlamaz — ve
BigQuery'ye ulaşılamadığında hiçbir transactional tabloyu (payments/bookings) bozmaz.
Ayrıca ödeme mutabakat taraması, tanımlanan üç dahili tutarsızlık türünü (yanıtsız
komut, işlenmemiş yetki süresi dolumu, takılı release) doğru tespit eder, para hareketi
tetiklemez ve aynı bulguyu tekrar yazmaz (dedup).

## Yöntem

EXP-005 ile aynı yaklaşım: bu, istatistiksel bir ölçüm değil, **deterministik davranış**
iddiasıdır. Sonuçlar `services/api/test/analytics.integration.spec.ts`'te (gerçek
Postgres, `MockBigQueryAdapter` — yalnızca dış GCP sınırı sahtelenir, domain servisleri
gerçek koddur) 15 test senaryosuyla doğrulanır.

## Senaryolar ve doğrulama

1. **Ingestion:** `exported_at IS NULL` satırlar export edilir ve işaretlenir.
   Doğrulama: "exported_at NULL olan satırları export eder ve işaretler".
2. **Idempotency:** İkinci export turu zaten işaretlenmiş satırları tekrar göndermez.
   Doğrulama: "ikinci tur zaten export edilmiş satırları tekrar göndermez".
3. **Event versioning:** `event_version` alanı elenmeden export edilir (şema evrimi
   BigQuery tarafında ayrıştırılır, core tarafında değil — payload olduğu gibi taşınır).
   Doğrulama: "event_version korunur ve export edilir".
4. **Data-quality failure izolasyonu:** BigQuery insert hatası `exported_at`
   işaretlemez ve hiçbir booking/payment tablosuna dokunmaz (analitik hata
   transactional durumu bozmaz — ADR-0021 §6).
   Doğrulama: "BigQuery hatası exported_at işaretlemez".
5. **Concurrency (çift claim yok):** İki eşzamanlı export turu aynı satırı
   iki kez sahiplenmez; toplam export sayısı satır sayısına eşittir (ne az ne
   fazla). Atomik `UPDATE ... FOR UPDATE SKIP LOCKED` deseni doğrulanır.
   Doğrulama: "kira süresi dolmadan ikinci worker aynı satırı tekrar sahiplenemez".
6. **STUCK_PENDING_COMMAND:** Eşik süresinden eski `PENDING` komut tespit edilir,
   ödeme durumu değişmez (para hareketi yok).
7. **AUTHORIZATION_EXPIRED_UNHANDLED:** Bağışıklık penceresi (grace) dışına çıkmış
   süresi dolmuş yetkilendirme tespit edilir; pencere içindeyken bayraklanmaz
   (yanlış pozitif testi ayrıca var).
8. **RELEASE_PENDING_STALLED:** Eşikten eski `RELEASE_PENDING` ödeme tespit edilir.
9. **Dedup:** Aynı bulgu ikinci turda `newDiscrepancyCount`'a girmez ama aday
   olarak (`discrepancyCount`) raporlanmaya devam eder; DB'de tek satır kalır.
10. **Veri minimizasyonu:** Bulgu `details` alanı yalnızca beklenen operasyonel
    anahtarları taşır (tutar/kart/kimlik verisi yok) — allowlist testiyle.
11. **RBAC:** `SUPPORT` listeler ama tetikleyemez/kapatamaz (403); `ADMIN` tetikler,
    kapatır, her ikisi de `audit_logs`'a yazılır.
12. **Regresyon:** Export/mutabakat worker'ları varsayılan olarak kapalıyken
    (`ANALYTICS_EXPORT_ENABLED=false`, `RECONCILIATION_ENABLED=false`) Faz 5'in
    normal yetkilendirme akışı değişmeden çalışır.

## Sonuçlar

- 15/15 senaryo yeşil, deterministik (`npm run test:integration --workspace=@emek/api`,
  `test/analytics.integration.spec.ts`).
- Migration (`20260923090000_analytics-reconciliation`) up/down temiz (dev + test DB).
- Claim/lease deseni Faz 7'nin "transaction içinde ağ çağrısı" bulgusunu tekrarlamaz:
  export sırasında hiçbir satır kilitli değildir (yalnızca kısa `UPDATE ... RETURNING`
  ifadesi sırasında).

## Kararlar

- **Export ve mutabakat worker'ları production varsayılanı kapalıdır**
  (`ANALYTICS_EXPORT_ENABLED`/`RECONCILIATION_ENABLED=false`): Faz 11'in kapsamı
  altyapıyı doğru kurmaktır, gerçek GCP bağlantısını canlıya almak Faz 13 DevOps
  kapsamındadır (Terraform, gerçek proje/dataset, alarm).
- **Mutabakat kapsamı dahili tutarlılıkla sınırlı kalır** (R-79): dış PSP
  entegrasyonu ayrı bir karar ve port genişletmesi gerektirir.
- **AI/NLP ve iki ESG metriği (R-80, R-81) bu fazda üretilmedi**, uydurulmadı;
  gerekçe ADR-0021 ve `docs/architecture/analytics.md`'de.
