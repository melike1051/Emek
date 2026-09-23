# Hassas Veri Envanteri ve Saklama Kuralları

Son güncelleme: 2026-09-23 (Faz 12). İlgili: ADR-0013, ADR-0022,
`docs/security/data-protection-baseline.md`.

Bu belge **tek envanterdir**: hangi tablo hangi hassasiyet sınıfını taşır, ne kadar
saklanır, hangi iş siler. Belgelenmiş ama uygulanmayan bir saklama süresi, saklama
politikası değildir — "Silen iş" sütunu boş bırakılamaz.

Sınıflar (`data-protection-baseline.md`): **K1** kamuya açık · **K2** iç · **K3** kişisel
· **K4** özel nitelikli / yüksek riskli.

## 1. Envanter

| Tablo / veri                                     | Sınıf | Ne saklanır                                       | Süre                                                                                                                                   | Silen iş                                         |
| ------------------------------------------------ | ----- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `users` (e-posta, telefon)                       | K3    | İletişim kanalı                                   | Hesap kapatılana kadar                                                                                                                 | `markDeleted` (anında boşaltır)                  |
| `users` (satırın kendisi)                        | K3    | Pseudonim kimlik referansı                        | **Süresiz** — mali/denetim referansı                                                                                                   | Yok (bilinçli); anonimleştirilir                 |
| `customer_profiles` / `provider_profiles`        | K3    | Görünen ad, biyografi, tercihler                  | `RETENTION_DELETED_USER_DAYS` (30)                                                                                                     | `RetentionService.anonymizeDeletedUsers`         |
| `addresses`                                      | K3    | Açık adres, tam koordinat                         | `RETENTION_DELETED_USER_DAYS` (30)                                                                                                     | `RetentionService.anonymizeDeletedUsers`         |
| `identity_records.identity_hash`                 | K4    | HMAC özeti (ham numara **yok**)                   | Süresiz — tekillik kaynağı                                                                                                             | Yok (bilinçli, ADR-0004 §5)                      |
| `verification_attempts`                          | K3    | Sağlayıcı oturumu, sonuç kodu (ham hata **yok**)  | `RETENTION_VERIFICATION_ATTEMPT_DAYS` (180)                                                                                            | `RetentionService.purgeByAge`                    |
| `account_recovery_requests`                      | K3    | Kurtarma talebi ve kararı                         | Süresiz — devralma incelemesi kaydı                                                                                                    | Yok (bilinçli)                                   |
| `location_events`                                | K4    | Ham GPS izi                                       | `SAFETY_LOCATION_RETENTION_DAYS` (30); panik/uyuşmazlıkta `SAFETY_EVIDENCE_RETENTION_DAYS` (365)                                       | `SafetyMaintenanceService.purgeExpiredLocations` |
| `safety_risk_assessments` / `safety_events`      | K3    | Karar ve sinyaller (ham konum **yok**)            | Süresiz — güvenlik kararı kaydı                                                                                                        | Yok (bilinçli)                                   |
| `bookings`, `booking_status_history`             | K3    | Hizmet kaydı                                      | Süresiz — mali/hukuki                                                                                                                  | Yok (bilinçli)                                   |
| `payments`, `payment_events`, `payment_commands` | K3    | Tutar, durum, PSP referansı (kart verisi **yok**) | Süresiz — mali kayıt                                                                                                                   | Yok (bilinçli)                                   |
| `disputes`                                       | K3    | Uyuşmazlık dosyası                                | Süresiz — hukuki                                                                                                                       | Yok (bilinçli)                                   |
| `documents` (metadata)                           | K4    | `storage_key`, `sha256`, tip                      | Süresiz — kanıt bütünlüğü                                                                                                              | Yok (bilinçli)                                   |
| Storage nesneleri (before/after)                 | K4    | Müşteri evinin fotoğrafı                          | **TODO(legal)** — süre. Uygulama: `documents` bucket'ında lifecycle kuralı (`evidence_retention_days`, Terraform) — silen iş artık var | ✅ Faz 13 (R-83); süre A-04                      |
| `audit_logs`                                     | K3    | Kim, ne, ne zaman (hassas alan **yok**)           | Süresiz — hash zinciri kırılamaz                                                                                                       | Yok (bilinçli); arşiv ADR-0013 §8                |
| `audit_chain_checkpoints`, `audit_exports`       | K2    | Doğrulama ve arşiv kaydı                          | Süresiz — append-only                                                                                                                  | Yok (bilinçli)                                   |
| `processed_events`                               | K2    | Event tekilleştirme                               | `RETENTION_PROCESSED_EVENT_DAYS` (30)                                                                                                  | `RetentionService.purgeByAge`                    |
| `dead_letter_events` (çözülmüş)                  | K2    | Başarısız event yükü (PII **yok**)                | `RETENTION_DEAD_LETTER_DAYS` (90)                                                                                                      | `RetentionService.purgeResolvedDeadLetters`      |
| `dead_letter_events` (çözülmemiş)                | K2    | Operatör kuyruğu                                  | Çözülene kadar                                                                                                                         | Yok (bilinçli)                                   |
| `analytics_events` (aktarılmış)                  | K2    | Event zarfı kopyası (PII **yok**)                 | `RETENTION_ANALYTICS_EVENT_DAYS` (90)                                                                                                  | `RetentionService.purgeExportedAnalytics`        |
| `analytics_events` (aktarılmamış)                | K2    | Henüz BigQuery'de yok                             | Aktarılana kadar                                                                                                                       | Yok (bilinçli — kanonik kopya kaybolurdu)        |
| `idempotency_keys`                               | K2    | İstek tekilleştirme                               | Kayıt TTL'i                                                                                                                            | `IdempotencyService.purgeExpired`                |
| BigQuery `raw_events`                            | K2    | Analitik kopya                                    | **TODO(legal)** — süre. Uygulama: `raw_events` partition expiration (`analytics_table_expiration_days`, Terraform)                     | ✅ Faz 13 (R-83); süre A-04                      |

## 2. "Silen iş yok" gerekçeleri

Bir satırın süresiz saklanması bir ihmal değil, bir karardır. Üç gerekçe grubu:

- **Mali ve hukuki saklama.** `bookings`, `payments`, `disputes` ve bunlara atıfta
  bulunan `users` satırı. Silmek, uyuşmazlıkta tarafların iddiasını doğrulayacak kaydı
  yok etmek olurdu. `TODO(legal)`: mali kayıt saklama süresi (Türkiye mevzuatı) hukuk
  görüşüyle netleşecek (A-04).
- **Bütünlük kaynağı.** `audit_logs` hash zinciriyle bağlıdır: ortadan satır silmek
  zinciri kırar ve tüm denetim izini şüpheli yapar. `identity_records.identity_hash`
  tekilliğin tek kaynağıdır (ADR-0004 §5).
- **Güvenlik kararı kaydı.** `safety_risk_assessments`, `account_recovery_requests`:
  bir kararın neden verildiğini gösteren kayıt, kararın kendisinden uzun yaşamalıdır.
  Bu tablolar ham konum veya kimlik verisi **taşımaz**.

## 3. Hesap kapatma ve anonimleştirme

`markDeleted` → `status='DELETED'`, `email`/`phone` **anında** boşaltılır,
`deleted_at` saatini başlatır (tekrarlanan çağrı saati sıfırlamaz).

`RETENTION_DELETED_USER_DAYS` sonra `RetentionService`:

- `customer_profiles.display_name` / `provider_profiles.display_name` → sabit pseudonim
  ("Silinmiş kullanıcı"). Tamamen kaldırılamaz (NOT NULL + boşluk CHECK'i) ve profil
  satırını silmek geçmiş rezervasyonların bağlamını koparırdı.
- `provider_profiles.bio` → NULL, `customer_profiles.preferences` → `{}`.
- `addresses.line` → 'anonim', `label` → NULL, koordinat 1 ondalığa yuvarlanır
  (≈11 km — şehir düzeyinde istatistik kalır, ev bulunamaz).
- `users.anonymized_at` işaretlenir; ikinci bir tur aynı hesabı tekrar işlemez.
- İşlem `USER_ANONYMIZED` ile audit'lenir.

`TODO(legal)`: KVKK'nın "silme" talebinin anonimleştirme ile karşılanıp karşılanmadığı,
ve mali saklama yükümlülüğü ile silme hakkının nasıl dengeleneceği hukuk görüşüyle
doğrulanacaktır (A-04, R-38).

## 4. Doğrulama

Saklama kurallarının gerçekten uygulandığı `test/security.integration.spec.ts`'te
test edilir (T-24): süresi dolmuş hesabın profil adı, adres satırı ve koordinatı
değişir; süresi dolmamış hesaba dokunulmaz; aktif hesap hiçbir koşulda
anonimleştirilmez; tarama idempotenttir; aktarılmamış analytics event silinmez.

Ham konum retention'ı `test/safety.integration.spec.ts`'te ayrıca test edilir.
