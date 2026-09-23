# Penetration Test Checklist

Son güncelleme: 2026-09-23 (Faz 12). İlgili: ADR-0013, ADR-0022,
`docs/security/rbac-matrix.md`, `docs/security/data-retention-inventory.md`.

Bu liste **pratik bir koşu listesidir**: her madde ya otomatik bir testle ya da elle
yapılacak somut bir denemeyle karşılanır. "Durum" sütunu bugünkü gerçeği söyler.

- ✅ otomatik testle korunuyor (test adı verilir)
- ⚠️ kısmen — sınırı belirtilir
- ⬜ henüz doğrulanmadı (fazı belirtilir)

## 1. Kimlik doğrulama

| #   | Kontrol                                                    | Durum                                                                    |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| A1  | Token'sız istek korumalı rotaya erişemez (deny by default) | ✅ `auth-rbac` — "token olmadan korumalı endpoint 401"                   |
| A2  | Bozuk/imzasız token reddedilir, **neden sızdırılmaz**      | ✅ `auth-rbac` — "geçersiz biçimli token ... nedeni sızdırmaz"           |
| A3  | `Bearer` öneki olmayan başlık reddedilir                   | ✅ `auth-rbac`                                                           |
| A4  | Geçerli token ama Emek kullanıcısı yoksa 401               | ✅ `auth-rbac`                                                           |
| A5  | `SUSPENDED`/`DELETED` hesap erişemez                       | ✅ `auth-rbac`                                                           |
| A6  | Yetki kaynağı token claim'i **değil**, Emek RBAC tablosu   | ✅ `AuthGuard` rolleri DB'den okur                                       |
| A7  | Süresi geçmiş token kabul edilmez (clock tolerance ≤ 5 sn) | ⚠️ `FirebaseTokenVerifier` unit testi; gerçek Firebase token'ıyla Faz 16 |
| A8  | Mock doğrulayıcı production'da reddedilir                  | ✅ `env.schema.spec`                                                     |

## 2. Yetkilendirme ve nesne sahipliği

| #   | Kontrol                                                      | Durum                                                          |
| --- | ------------------------------------------------------------ | -------------------------------------------------------------- |
| B1  | Başkasının rezervasyonu **404** döner (varlık bile sızmaz)   | ✅ `bookings` — taraf olmayan kullanıcı                        |
| B2  | Başkasının dokümanı indirilemez                              | ✅ `documents`                                                 |
| B3  | Başkasının adresi/profili okunamaz-yazılamaz                 | ✅ `profiles-catalog`, `bookings`                              |
| B4  | Başkasının güvenlik oturumu okunamaz                         | ✅ `safety`                                                    |
| B5  | Rol kontrolü sahiplik kontrolünün yerine geçmez              | ✅ `RolesGuard` dokümantasyonu + `documents` (ADMIN ayrı kapı) |
| B6  | `CUSTOMER` ops/admin uçlarını göremez                        | ✅ `security` — "CUSTOMER ops uçlarını hiç göremez"            |
| B7  | Rol kendi kendine yükseltilemez (`user_roles` yazma ucu yok) | ✅ Rota envanteri — `route-coverage`                           |
| B8  | Kendi kendine rezervasyon yasak (metrik manipülasyonu)       | ✅ `bookings` + DB CHECK                                       |
| B9  | Guard'sız endpoint yok                                       | ✅ `route-coverage` (T-37)                                     |

## 3. ADMIN / SUPPORT ayrımı

| #   | Kontrol                                                     | Durum                        |
| --- | ----------------------------------------------------------- | ---------------------------- |
| C1  | SUPPORT okuyabilir, yıkıcı/mali işlem yapamaz               | ✅ `security`, `admin`       |
| C2  | SUPPORT retention taramasını (veri silme) tetikleyemez      | ✅ `security`                |
| C3  | SUPPORT audit doğrulamasını tetikleyemez, durumu okuyabilir | ✅ `security`                |
| C4  | SUPPORT booking state geçişi tetikleyemez                   | ✅ transition map unit testi |
| C5  | SUPPORT dead-letter / bildirim işi çözemez                  | ✅ `admin`                   |
| C6  | SUPPORT kurtarma talebini onaylayamaz                       | ✅ `admin`                   |

## 4. Oturum ve hesap kurtarma

| #   | Kontrol                                                                                                    | Durum                                            |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| D1  | Kimlik eşleşmesi kurtarmayı **tamamlamaz**, inceleme açar                                                  | ✅ `identity` (T-02)                             |
| D2  | Operatör onaylayan, talebin tarafı **olamaz** (R-36)                                                       | ✅ `admin` — "kendi talebini onaylayamaz"        |
| D3  | Onayda hedef hesabın eski oturum kimliği `REVOKED` olur                                                    | ✅ `moveAuthSubject` + `identity`                |
| D4  | `HIGH` güvence zorunlu; zayıf doğrulama talep açamaz                                                       | ✅ `identity`                                    |
| D5  | Hedef hesap başına tek bekleyen talep                                                                      | ✅ `identity`                                    |
| D6  | Kabuk hesabın kendi verisi varsa talep açılmaz (onayda tekrar kontrol)                                     | ✅ `identity`, `approveRecovery`                 |
| D7  | Her adım audit'li                                                                                          | ✅ `identity`                                    |
| D8  | **Elle:** `HIGH` güvencenin gerçekten canlılık/yüz eşleştirme içerdiği sağlayıcı sözleşmesinden doğrulanır | ⬜ R-36 açık — sağlayıcı seçimiyle (TODO(legal)) |

## 5. API suistimali ve oran sınırı

| #   | Kontrol                                                                  | Durum                                                       |
| --- | ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| E1  | `X-Forwarded-For` değiştirerek IP sınırı atlatılamaz                     | ✅ `security`, `client-ip.spec` (R-53)                      |
| E2  | Express `trust proxy` açık değil                                         | ✅ SAST kuralı `emek-no-express-trust-proxy`                |
| E3  | Redis erişilemezken sınır **fail-closed**                                | ✅ `rate-limit.guard.spec`, `user-rate-limit.guard.spec`    |
| E4  | Kullanıcı başına kota: bir hesap diğerlerinin kotasını tüketemez         | ✅ `user-rate-limit.guard.spec`                             |
| E5  | Kimlik doğrulama uçlarında brute-force sınırı                            | ✅ `auth-session` + `verification-session` (IP + kullanıcı) |
| E6  | Panik ucu **hiç** bloklanmaz                                             | ✅ `safety` — panik oran sınırı kullanmaz (ADR-0008 §3)     |
| E7  | **Elle:** dağıtık sel (çok IP) senaryosu                                 | ⬜ Faz 14 (load testing)                                    |
| E8  | Numaralandırma: var olmayan kaynak ile yetkisiz kaynak aynı yanıtı verir | ✅ `bookings`, `documents` (404)                            |

## 6. İstemci bütünlüğü (App Check)

| #   | Kontrol                                                            | Durum                     |
| --- | ------------------------------------------------------------------ | ------------------------- |
| F1  | Token'sız istek reddedilir (deny by default)                       | ✅ `app-check`            |
| F2  | Geçersiz token reddedilir, neden sızmaz                            | ✅ `app-check`            |
| F3  | App Check kimlik doğrulamadan **önce** çalışır                     | ✅ `app-check`            |
| F4  | App Check kimlik doğrulamanın yerine **geçmez**                    | ✅ `app-check`            |
| F5  | Webhook/callback/health uçları istisna ve imza modeliyle korunuyor | ✅ `app-check`            |
| F6  | Production'da App Check kapalı bırakılamaz                         | ✅ `env.schema.spec`      |
| F7  | **Elle:** gerçek Firebase App Check token'ıyla uçtan uca           | ⬜ Faz 16 (mobil istemci) |

## 7. Dosya ve doküman erişimi

| #   | Kontrol                                                                    | Durum                  |
| --- | -------------------------------------------------------------------------- | ---------------------- |
| G1  | Nesneler private; public URL üretme yeteneği portta yok                    | ✅ `storage.port.ts`   |
| G2  | İndirme yalnızca kısa ömürlü signed URL ile (≤ 1 saat)                     | ✅ `documents` (T-12)  |
| G3  | Erişim yalnızca rezervasyon taraflarına + ADMIN; SUPPORT **hariç**         | ✅ `documents`         |
| G4  | Her erişim audit'li                                                        | ✅ `documents`         |
| G5  | `sha256` storage'daki nesneden okunur, istemci beyanına güvenilmez         | ✅ `documents`         |
| G6  | Path traversal: `storage_key` sunucuda üretilir, istemciden alınmaz        | ✅ `documents.service` |
| G7  | **Elle:** signed URL süresi dolduktan sonra erişim reddedilir (gerçek GCS) | ⬜ Faz 13              |

## 8. Ödeme

| #   | Kontrol                                                                | Durum                                    |
| --- | ---------------------------------------------------------------------- | ---------------------------------------- |
| H1  | Webhook imzası ham gövde üzerinden doğrulanır                          | ✅ `payments`                            |
| H2  | İmzasız/yanlış imzalı/gövdesi değiştirilmiş webhook reddedilir         | ✅ `payments`                            |
| H3  | Replay ikinci para hareketi üretmez (`external_event_id` UNIQUE)       | ✅ `payments`                            |
| H4  | Giden çağrılar kendi idempotency anahtarını taşır (`payment_commands`) | ✅ `payments` (ADR-0017 §4)              |
| H5  | Event'ten para hareketi tetiklenmez                                    | ✅ `events`, `scheduled-release`         |
| H6  | Fiyat sunucuda hesaplanır; istemci tutar gönderemez                    | ✅ `bookings` DTO'sunda `priceMinor` yok |
| H7  | Para serbest bırakılmadan `SETTLED` olunamaz                           | ✅ `payments`                            |
| H8  | Yetkilendirme süresi dolmuşsa release reddedilir                       | ✅ `payments`                            |
| H9  | Taraf olmayan kullanıcı ödeme işlemi tetikleyemez                      | ✅ `payments`                            |
| H10 | Kart verisi hiçbir tabloda/log'da yok                                  | ✅ Veri minimizasyonu testi              |

## 9. Kimlik (identity)

| #   | Kontrol                                                               | Durum                                        |
| --- | --------------------------------------------------------------------- | -------------------------------------------- |
| I1  | Ham T.C. kimlik numarası hiçbir sütunda/audit'te/event'te/yanıtta yok | ✅ `identity` (tüm tabloları tarayan test)   |
| I2  | `identity_hash` API yanıtlarında dönmüyor                             | ✅ `identity`                                |
| I3  | Tekillik DB constraint'iyle, sağlayıcıdan bağımsız                    | ✅ `identity` (T-01, T-01b)                  |
| I4  | Callback imzası adapter içinde, ham gövde üzerinden doğrulanır        | ✅ `identity`                                |
| I5  | Callback replay ikinci yan etki üretmez                               | ✅ `identity`                                |
| I6  | Deterministik hash üretemeyen sağlayıcı doğrulanmış seviye veremez    | ✅ `identity` (T-01c)                        |
| I7  | Anahtar rotasyonu **yok**; göç prosedürü belgeli                      | ✅ `docs/security/identity-key-migration.md` |
| I8  | **Elle:** production KMS adapter'ı ile hash üretimi                   | ⬜ R-39, Faz 13                              |

## 10. Güvenlik (safety) alanı

| #   | Kontrol                                                             | Durum              |
| --- | ------------------------------------------------------------------- | ------------------ |
| J1  | Telemetri yalnızca aktif oturuma bağlı; 7/24 takip yok              | ✅ `safety`        |
| J2  | Sunucu zamanı yetkili; geleceğe tarihli örnek reddedilir            | ✅ `safety`        |
| J3  | Oturum bazlı monoton sıra numarası replay'i engeller                | ✅ `safety`        |
| J4  | Mock-location sinyali kayda geçer                                   | ✅ `safety`        |
| J5  | Ham konum yalnızca operatöre, audit'li (`SAFETY_LOCATION_ACCESSED`) | ✅ `safety`        |
| J6  | Ham konum retention'ı gerçekten siliyor                             | ✅ `safety` (T-24) |
| J7  | Panik deterministik, ML beklemez, bloklanamaz                       | ✅ `safety`        |
| J8  | Başka oturumun telemetrisi yazılamaz                                | ✅ `safety`        |

## 11. Event sistemi

| #   | Kontrol                                                          | Durum                                       |
| --- | ---------------------------------------------------------------- | ------------------------------------------- |
| K1  | Event payload'larında PII yok, yalnızca ID referansları          | ✅ `event-contracts.spec`                   |
| K2  | Aynı event iki kez işlenmez (`processed_events`)                 | ✅ `events`                                 |
| K3  | Consumer kendi idempotency'sinden sorumlu; yan etki tekrarlanmaz | ✅ `events`                                 |
| K4  | Kalıcı hata DLQ'ya gider, geçici hata yeniden denenir            | ✅ `failure-classifier.spec`, `events`      |
| K5  | Dışarıdan event enjeksiyonu: Pub/Sub'a yazma yetkisi yok         | ⬜ Faz 13 (IAM least privilege — Terraform) |
| K6  | Outbox ve yan etki aynı transaction'da                           | ✅ `events`                                 |

## 12. Veri sızıntısı ve log redaksiyonu

| #   | Kontrol                                                          | Durum                                               |
| --- | ---------------------------------------------------------------- | --------------------------------------------------- |
| L1  | Hata yanıtları iç detay (stack, SQL, sağlayıcı metni) sızdırmaz  | ✅ `auth-rbac` (T-31), `all-exceptions.filter.spec` |
| L2  | Log'lar PII taşımaz; redaksiyon listesi uygulanır                | ✅ `logger.spec`, `redact.ts`                       |
| L3  | `console` kullanımı yok (redaksiyon katmanını atlar)             | ✅ SAST kuralı `emek-no-console-logging`            |
| L4  | `request_id` sunucuda üretilir; istemci audit izini bulandıramaz | ✅ `request-context.middleware.spec`                |
| L5  | İstemci trace id log injection'a karşı biçim kontrollü           | ✅ `request-context.middleware.spec`                |
| L6  | Audit `old_value`/`new_value` hassas alan taşımaz                | ✅ Veri minimizasyonu testi                         |

## 13. Enjeksiyon ve girdi doğrulama

| #   | Kontrol                                                                                | Durum                                                     |
| --- | -------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| M1  | Tüm SQL parametreli; tanımlayıcı enterpolasyonu beyaz listeli ve `nosemgrep` gerekçeli | ✅ SAST kuralı `emek-no-string-interpolated-sql`          |
| M2  | `whitelist` + `forbidNonWhitelisted` ile bilinmeyen alan reddedilir                    | ✅ `bootstrap.ts` + DTO testleri                          |
| M3  | Komut çalıştırma yok (`child_process` kullanılmıyor)                                   | ✅ SAST (p/security-audit)                                |
| M4  | SSRF: dışa giden çağrılar sabit yapılandırılmış URL'lere (AI servisi, PSP, JWKS)       | ✅ Kod incelemesi; kullanıcı girdisinden URL türetilmiyor |
| M5  | Path traversal: dosya yolu istemciden alınmıyor                                        | ✅ `documents.service`                                    |
| M6  | Prototype pollution / unsafe deserialization                                           | ✅ SAST (p/typescript, p/security-audit)                  |

## 14. Denetim izi bütünlüğü

| #   | Kontrol                                                   | Durum                                                         |
| --- | --------------------------------------------------------- | ------------------------------------------------------------- |
| N1  | `audit_logs` UPDATE/DELETE/TRUNCATE trigger'la engellenir | ✅ `infrastructure`                                           |
| N2  | Hash zinciri kopukluğu tespit edilir                      | ✅ `security` (T-36)                                          |
| N3  | Doğrulama tarihsel kayıtları değiştirmez                  | ✅ `security`                                                 |
| N4  | Doğrulama geçmişi de append-only                          | ✅ `security`                                                 |
| N5  | Kopukluk bulunduktan sonra sessizce ilerlenmez            | ✅ `security`                                                 |
| N6  | Audit işlemle **aynı transaction'da** yazılır             | ✅ `infrastructure` + modül testleri                          |
| N7  | Retention-locked arşiv gerçek değişmez depolamada         | ⬜ R-82, Faz 13 (bucket retention policy)                     |
| N8  | DB rol ayrımı (uygulama rolüne UPDATE/DELETE yok)         | ⚠️ `REVOKE ... FROM PUBLIC` var; tam rol ayrımı Faz 13 (T-35) |

## 15. Altyapı varsayımları (Faz 13'te doğrulanacak)

| #   | Kontrol                                                             | Durum                                                                              |
| --- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| O1  | Secret'lar Secret Manager'da; repoda secret yok                     | ✅ SAST `p/secrets` + config şeması (yerel varsayılanlar production'da reddedilir) |
| O2  | KMS anahtarı non-exportable, rotasyon kapalı                        | ⬜ R-39, Faz 13                                                                    |
| O3  | IAM least privilege (Cloud Run SA, Pub/Sub, Storage, BigQuery)      | ⬜ Faz 13                                                                          |
| O4  | Cloud SQL rol ayrımı (migration ≠ uygulama kullanıcısı)             | ⬜ T-35, Faz 13                                                                    |
| O5  | `TRUSTED_PROXY_HOP_COUNT` gerçek Cloud Run topolojisinde doğrulandı | ⬜ Faz 13                                                                          |
| O6  | Storage bucket private + lifecycle policy                           | ⬜ R-83, Faz 13                                                                    |
| O7  | Container non-root, multi-stage, minimal taban imaj                 | ⬜ Faz 13                                                                          |
| O8  | TLS zorunlu, HSTS                                                   | ⬜ Faz 13                                                                          |

## 16. Bu listenin sınırı

Buradaki ✅'ler **otomatik testlerin** kapsadığını söyler, "sistem güvenli" demez.
Otomatik test yazarın düşündüğü saldırıyı kontrol eder; bağımsız bir sızma testi
düşünülmemiş olanı arar. ⬜ maddelerin çoğu altyapı gerektirir ve Faz 13 öncesi
kapatılamaz — bu, listenin eksikliği değil, projenin bugünkü gerçeğidir.
