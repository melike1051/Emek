# Hassas Veri Envanteri ve Saklama Kuralları

Son güncelleme: 2026-09-23 (Faz 12). İlgili: ADR-0013, ADR-0022,
`docs/security/data-protection-baseline.md`.

Bu belge **tek envanterdir**: hangi tablo hangi hassasiyet sınıfını taşır, ne kadar
saklanır, hangi iş siler. Belgelenmiş ama uygulanmayan bir saklama süresi, saklama
politikası değildir — "Silen iş" sütunu boş bırakılamaz.

Sınıflar (`data-protection-baseline.md`): **K1** kamuya açık · **K2** iç · **K3** kişisel
· **K4** özel nitelikli / yüksek riskli.

## 1. Envanter

| Tablo / veri                                     | Sınıf | Ne saklanır                                       | Süre                                                                                                                                   | Silen iş                                                   |
| ------------------------------------------------ | ----- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `users` (e-posta, telefon)                       | K3    | İletişim kanalı                                   | Hesap kapatılana kadar                                                                                                                 | `markDeleted` (anında boşaltır)                            |
| `users` (satırın kendisi)                        | K3    | Pseudonim kimlik referansı                        | **Süresiz** — mali/denetim referansı                                                                                                   | Yok (bilinçli); anonimleştirilir                           |
| `customer_profiles` / `provider_profiles`        | K3    | Görünen ad, biyografi, tercihler                  | `RETENTION_DELETED_USER_DAYS` (30)                                                                                                     | `RetentionService.anonymizeDeletedUsers`                   |
| `user_devices` (push token)                      | K3    | FCM kayıt token'ı, platform, son görülme          | Son görülmeden `RETENTION_DEVICE_TOKEN_DAYS` (90); hesap anonimleştirilince hemen                                                      | `RetentionService` (`purgeByAge`, `anonymizeDeletedUsers`) |
| `addresses`                                      | K3    | Açık adres, tam koordinat                         | `RETENTION_DELETED_USER_DAYS` (30)                                                                                                     | `RetentionService.anonymizeDeletedUsers`                   |
| `identity_records.identity_hash`                 | K4    | HMAC özeti (ham numara **yok**)                   | Süresiz — tekillik kaynağı                                                                                                             | Yok (bilinçli, ADR-0004 §5)                                |
| `verification_attempts`                          | K3    | Sağlayıcı oturumu, sonuç kodu (ham hata **yok**)  | `RETENTION_VERIFICATION_ATTEMPT_DAYS` (180)                                                                                            | `RetentionService.purgeByAge`                              |
| `account_recovery_requests`                      | K3    | Kurtarma talebi ve kararı                         | Süresiz — devralma incelemesi kaydı                                                                                                    | Yok (bilinçli)                                             |
| `location_events`                                | K4    | Ham GPS izi                                       | `SAFETY_LOCATION_RETENTION_DAYS` (30); panik/uyuşmazlıkta `SAFETY_EVIDENCE_RETENTION_DAYS` (365)                                       | `SafetyMaintenanceService.purgeExpiredLocations`           |
| `safety_risk_assessments` / `safety_events`      | K3    | Karar ve sinyaller (ham konum **yok**)            | Süresiz — güvenlik kararı kaydı                                                                                                        | Yok (bilinçli)                                             |
| `bookings`, `booking_status_history`             | K3    | Hizmet kaydı                                      | Süresiz — mali/hukuki                                                                                                                  | Yok (bilinçli)                                             |
| `payments`, `payment_events`, `payment_commands` | K3    | Tutar, durum, PSP referansı (kart verisi **yok**) | Süresiz — mali kayıt                                                                                                                   | Yok (bilinçli)                                             |
| `disputes`                                       | K3    | Uyuşmazlık dosyası                                | Süresiz — hukuki                                                                                                                       | Yok (bilinçli)                                             |
| `documents` (metadata)                           | K4    | `storage_key`, `sha256`, tip                      | Süresiz — kanıt bütünlüğü                                                                                                              | Yok (bilinçli)                                             |
| Storage nesneleri (before/after)                 | K4    | Müşteri evinin fotoğrafı                          | **TODO(legal)** — süre. Uygulama: `documents` bucket'ında lifecycle kuralı (`evidence_retention_days`, Terraform) — silen iş artık var | ✅ Faz 13 (R-83); süre A-04                                |
| `audit_logs`                                     | K3    | Kim, ne, ne zaman (hassas alan **yok**)           | Süresiz — hash zinciri kırılamaz                                                                                                       | Yok (bilinçli); arşiv ADR-0013 §8                          |
| `audit_chain_checkpoints`, `audit_exports`       | K2    | Doğrulama ve arşiv kaydı                          | Süresiz — append-only                                                                                                                  | Yok (bilinçli)                                             |
| `processed_events`                               | K2    | Event tekilleştirme                               | `RETENTION_PROCESSED_EVENT_DAYS` (30)                                                                                                  | `RetentionService.purgeByAge`                              |
| `dead_letter_events` (çözülmüş)                  | K2    | Başarısız event yükü (PII **yok**)                | `RETENTION_DEAD_LETTER_DAYS` (90)                                                                                                      | `RetentionService.purgeResolvedDeadLetters`                |
| `dead_letter_events` (çözülmemiş)                | K2    | Operatör kuyruğu                                  | Çözülene kadar                                                                                                                         | Yok (bilinçli)                                             |
| `analytics_events` (aktarılmış)                  | K2    | Event zarfı kopyası (PII **yok**)                 | `RETENTION_ANALYTICS_EVENT_DAYS` (90)                                                                                                  | `RetentionService.purgeExportedAnalytics`                  |
| `analytics_events` (aktarılmamış)                | K2    | Henüz BigQuery'de yok                             | Aktarılana kadar                                                                                                                       | Yok (bilinçli — kanonik kopya kaybolurdu)                  |
| `idempotency_keys`                               | K2    | İstek tekilleştirme                               | Kayıt TTL'i                                                                                                                            | `IdempotencyService.purgeExpired`                          |
| BigQuery `raw_events`                            | K2    | Analitik kopya                                    | **TODO(legal)** — süre. Uygulama: `raw_events` partition expiration (`analytics_table_expiration_days`, Terraform)                     | ✅ Faz 13 (R-83); süre A-04                                |

## 1.1 Silen işleri kim tetikler

Tablodaki her "silen iş" üretimde **otomatik** çalışır; Cloud Scheduler işi yoktur
ve gerekmez:

| İş                                                                            | Tetikleyici                                                                        | Aralık / koşul                                                    |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `RetentionService.sweep` (tablodaki `RetentionService.*` satırlarının tamamı) | `SecurityMaintenanceService.scheduleRetention` — uygulama içi `setTimeout` döngüsü | `RETENTION_INTERVAL_MS` (1 sa), koşul `RETENTION_ENABLED`         |
| `SafetyMaintenanceService` (`location_events`, kanıt dosyaları)               | kendi `setTimeout` döngüsü                                                         | `SAFETY_MONITOR_INTERVAL_SECONDS`, koşul `SAFETY_MONITOR_ENABLED` |
| `IdempotencyService.purgeExpired`                                             | kayıt TTL'i (Redis) + sweep                                                        | —                                                                 |
| BigQuery `raw_events`                                                         | partition expiration (Terraform)                                                   | `analytics_table_expiration_days`                                 |

`RETENTION_ENABLED` dağıtılan ortamlarda kapatılamaz: `env.schema.ts` `superRefine`
bunu reddeder ve Terraform Cloud Run tanımında `"true"` sabitlenmiştir.
`POST /ops/retention/sweep` otomatik yol **değildir** — elle çalıştırma ve test yoludur.
Döngünün kurulduğu `security-maintenance.service.spec.ts` ile test edilir.

Döngü uygulama instance'ı içinde yaşadığı için `api_min_instances >= 1` bu
politikanın parçasıdır: sıfıra ölçeklenen bir serviste container boşta kalınca kapanır
ve döngü onunla ölür. Kısıt Terraform'da `validation` bloğuyla zorlanır
(`modules/emek_environment/variables.tf`), yorumla değil — staging ve production'ın
ikisi de `1`.

Bu **yalnızca saatlik işleri** kurtarmak için gerekir: `SafetyMaintenanceService`
(30 sn) trafik varken zaten çalışır, ama `RetentionService.sweep` bir saatlik
aralıkla döner ve hiçbir ortam kendiliğinden bu kadar sıcak kalmaz. Staging'de
sürekli açık instance'ın maliyeti (~$50/ay, bütçenin üçte biri) bilinçli kabul
edilmiştir: alternatifi, retention'ın ilk kez production'da canlı veri üzerinde
kendi kendine çalışması olurdu. Daha ucuz iki yol (staging'de aralığı kısaltmak,
veya `/ops/retention/sweep`'e Cloud Scheduler bağlamak) değerlendirilip
**reddedildi** — gerekçe: staging'in production ile yapılandırma farkı taşımaması.

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
