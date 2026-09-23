# RBAC Yetenek Matrisi

Bağlayıcı karar: ADR-0013. Bu dosya kodla birlikte güncellenir; `route-coverage` integration
testi (T-37) beyaz liste dışındaki her açık endpoint'i kırar.

## İlkeler

1. **Deny by default.** Guard tüm rotalara uygulanır; yalnızca `@Public()` ile işaretlenmiş
   rotalar kimlik doğrulaması istemez. Bir rotayı açmak görünür, gözden geçirilebilir bir karardır.
2. **Rol tek başına yetki değildir.** Her erişim kararı rol **ve** kaynak sahipliği içerir.
3. **Yetki kaynağı token değil, Emek veritabanıdır.** Token doğrulandıktan sonra roller
   `user_roles` tablosundan okunur (ADR-0016): sağlayıcıdaki custom claim'ler yetki vermez.
4. **Sahiplik yüzeyi açılmaz.** Faz 2 endpoint'leri `/me` üzerinden çalışır; kullanıcı id'si
   yol parametresi olarak alınmaz, böylece IDOR yüzeyi hiç oluşmaz.

## Roller

| Rol        | Nasıl verilir                           | Kapsam                                         |
| ---------- | --------------------------------------- | ---------------------------------------------- |
| `CUSTOMER` | ilk oturum kurulumunda otomatik         | kendi kullanıcı kaydı ve müşteri profili       |
| `PROVIDER` | sağlayıcı profili oluşturulduğunda      | kendi sağlayıcı profili, yetkinlikleri         |
| `ADMIN`    | elle (Faz 10 admin API'siyle, audit'li) | operasyonel aksiyonlar                         |
| `SUPPORT`  | elle (audit'li)                         | okuma + not/etiket; **yıkıcı aksiyon yapamaz** |

`SUPPORT` rolü için kesin kısıt: ödeme serbest bırakma, refund, rol değişimi, silme ve
verification onayı **yasaktır**. Bu kısıtlar ilgili endpoint'lerle birlikte (Faz 5, 10) uygulanır
ve testlenir.

## Faz 2 endpoint matrisi

| Endpoint                                                             | Kimlik                                      | Rol                        | Sahiplik                          | Not                                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------- | -------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /health`, `GET /health/live`                                    | ❌ açık                                     | —                          | —                                 | orchestrator çağırır                                                                                 |
| `POST /auth/session`                                                 | token doğrulanır, Emek kullanıcısı gerekmez | —                          | —                                 | oran sınırı: 20/dk                                                                                   |
| `GET /users/me`                                                      | ✅                                          | —                          | kendi kaydı                       |                                                                                                      |
| `PATCH /users/me`                                                    | ✅                                          | —                          | kendi kaydı                       | e-posta/telefon E.164 doğrulanır                                                                     |
| `GET /users/me/roles`                                                | ✅                                          | —                          | kendi rolleri                     |                                                                                                      |
| `POST /customers/profile`                                            | ✅                                          | `CUSTOMER`                 | kendi profili                     |                                                                                                      |
| `GET`/`PATCH /customers/me`                                          | ✅                                          | `CUSTOMER`                 | kendi profili                     |                                                                                                      |
| `POST /providers/profile`                                            | ✅                                          | — (rol bu işlemle verilir) | kendi profili                     | `DRAFT` durumunda başlar                                                                             |
| `GET`/`PATCH /providers/me`                                          | ✅                                          | `PROVIDER`                 | kendi profili                     |                                                                                                      |
| `GET`/`POST /providers/me/skills`                                    | ✅                                          | `PROVIDER`                 | kendi yetkinlikleri               |                                                                                                      |
| `DELETE /providers/me/skills/:skillId`                               | ✅                                          | `PROVIDER`                 | kendi yetkinliği                  | yol parametresi sahibi belirtmez                                                                     |
| `GET /service-categories`, `/services`, `/services/:id`, `/skills`   | ❌ açık                                     | —                          | —                                 | referans veri, PII yok; oran sınırı: 120/dk                                                          |
| `POST /bookings/:id/payment`                                         | ✅                                          | —                          | **yalnızca müşteri**              | tutar rezervasyondan; istemci tutar göndermez                                                        |
| `GET /bookings/:id/payment`                                          | ✅                                          | —                          | rezervasyonun tarafı              | sağlayıcı referansı yanıtta yoktur                                                                   |
| `POST /payments/:id/release`, `/refund`, `/reauthorize`              | ✅                                          | `ADMIN`                    | —                                 | taraflar parayı kendileri hareket ettiremez                                                          |
| `POST /payments/webhook`                                             | ❌ açık — **imza doğrulanır**               | —                          | —                                 | ADR-0009 §7; imzasız çağrı 401, oran sınırı: 300/dk                                                  |
| `POST`/`GET /bookings/:id/disputes`                                  | ✅                                          | —                          | rezervasyonun tarafı              | açmak taraflara açıktır                                                                              |
| `POST /disputes/:id/resolve`                                         | ✅                                          | `ADMIN`                    | —                                 | taraf kendi lehine karar veremez                                                                     |
| `POST /documents`, `/documents/:id/confirm`                          | ✅                                          | —                          | rezervasyonun tarafı              | dosya API'den geçmez; imzalı URL                                                                     |
| `GET /documents/:id/download-url`                                    | ✅                                          | —                          | taraf veya sahibi (`ADMIN` dâhil) | kısa ömürlü imzalı URL; her erişim audit'li                                                          |
| `GET /bookings/:id/documents`                                        | ✅                                          | —                          | rezervasyonun tarafı              |                                                                                                      |
| `POST /bookings/:id/review`                                          | ✅                                          | —                          | rezervasyonun tarafı              | yalnızca `COMPLETED`/`SETTLED`; bir kez                                                              |
| `GET /users/:id/reviews`                                             | ✅                                          | —                          | —                                 | yazar kimliği yanıtta yoktur                                                                         |
| `POST /booking-requests/from-text`                                   | ✅                                          | —                          | kendi adresi                      | ham metin saklanır, audit'e yazılmaz; oran sınırı: 20/dk                                             |
| `POST /booking-requests`                                             | ✅                                          | —                          | kendi adresi                      | form yolu; AI servisine hiç dokunmaz (T-15)                                                          |
| `GET /booking-requests/:id`                                          | ✅                                          | —                          | kendi talebi                      | sahibi olmayan 404 alır                                                                              |
| `POST /booking-requests/:id/match`                                   | ✅ sahibi                                   | —                          | kendi talebi                      | başkasının talebi 404; rezervasyon oluşturur                                                         |
| `GET /booking-requests/:id/match`                                    | ✅ sahibi                                   | —                          | kendi talebi                      | yalnızca **seçilen** sağlayıcı döner (T-19)                                                          |
| `POST /matching/runs`                                                | —                                           | —                          | `ADMIN`                           | toplu eşleştirme; başkaları adına rezervasyon oluşturur                                              |
| `GET /matching/runs/:requestId`                                      | —                                           | —                          | `ADMIN`                           | tam sıralama + skor bileşenleri yalnızca burada                                                      |
| `GET/POST/DELETE /providers/me/services`                             | —                                           | ✅ kendi                   | —                                 | aday havuzunun hizmet kapısı                                                                         |
| `GET/POST/DELETE /providers/me/service-areas`                        | —                                           | ✅ kendi                   | —                                 | merkez + yarıçap; serbest poligon kabul edilmez                                                      |
| `GET /bookings/:id/safety-session`                                   | ✅ taraf                                    | ✅ taraf                   | —                                 | dar görünüm: risk, kural, skor, koordinat yok                                                        |
| `POST /safety/sessions/:id/telemetry`                                | —                                           | ✅ oturumun sağlayıcısı    | —                                 | başkasının oturumu 404; kullanıcı başı 60/dk (kimlik sonrası, süreç içi)                             |
| `POST /safety/sessions/:id/panic`                                    | ✅ taraf                                    | ✅ taraf                   | —                                 | `ARRIVAL_MONITORING`/`ACTIVE`'de; kişi başı tekil; oran sınırı yok; panik yalnızca başlatana görünür |
| `GET /safety/operator/sessions`, `GET /safety/operator/sessions/:id` | —                                           | —                          | `ADMIN`, `SUPPORT`                | koordinat yok; değerlendirme + olay geçmişi                                                          |
| `GET /safety/operator/sessions/:id/locations`                        | —                                           | —                          | `ADMIN`                           | ham iz; `reason` zorunlu; risksiz oturumda `breakGlass`; her okuma audit'li                          |
| `POST /safety/operator/sessions/:id/risk`                            | —                                           | —                          | `ADMIN`                           | gerekçe zorunlu; `EMERGENCY`'den inmek paniği çözer                                                  |
| `POST /safety/operator/sessions/:id/close`, `/evaluate`              | —                                           | —                          | `ADMIN`                           | audit'li                                                                                             |

## Faz 10 endpoint matrisi (admin/ops)

Ortak desen: read (liste/kuyruk) `ADMIN`+`SUPPORT`'a açık (triyaj), karar/yazma yalnızca
`ADMIN`'e — Faz 8'in operatör uçlarıyla aynı ayrım. Sahiplik kapısı yoktur (operasyon
tanımı gereği üçüncü taraf erişimidir); her karar `audit_logs`'a yazılır.

| Endpoint                                                               | Rol                | Not                                                                                       |
| ---------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------- |
| `GET /verification/recovery-requests`                                  | `ADMIN`, `SUPPORT` | varsayılan yalnızca `PENDING_REVIEW`; keyset sayfalama                                    |
| `POST /verification/recovery-requests/:id/approve`, `/reject`          | `ADMIN`            | devralma senaryosu nedeniyle yalnızca operatör (bkz. `IdentityService.approveRecovery`)   |
| `GET /providers/queue`                                                 | `ADMIN`, `SUPPORT` | varsayılan `PENDING_REVIEW`                                                               |
| `POST /providers/:userId/approve`, `/reject`, `/suspend`, `/reinstate` | `ADMIN`            | merkezî transition map (`provider-transitions.ts`); geçersiz geçiş 409                    |
| `POST /providers/me/submit`                                            | `PROVIDER`         | self-servis: `DRAFT`/`REJECTED` → `PENDING_REVIEW`                                        |
| `GET /bookings/admin`, `/payments/admin`, `/disputes/admin`            | `ADMIN`, `SUPPORT` | sahiplik kapısı yok; durum/taraf filtresiyle izleme                                       |
| `GET /safety/operator/events`                                          | `ADMIN`, `SUPPORT` | oturumdan bağımsız, `seq` ile global keyset sayfalama; salt okunur                        |
| `GET /matching/admin/stats`                                            | `ADMIN`, `SUPPORT` | özet metrik; ham skor bileşenleri yok (T-19 aynı gerekçe)                                 |
| `GET /ops/health`, `/dead-letter`, `/notification-jobs`                | `ADMIN`, `SUPPORT` | outbox/DLQ/bildirim işi durumu; payload'larda PII yok (event-catalog §1)                  |
| `POST /ops/dead-letter/:id/resolve`, `/notification-jobs/:id/retry`    | `ADMIN`            | id BIGSERIAL (`ParseIntPipe`); audit `entity_id` UUID olduğundan id `newValue`'da taşınır |
| `GET /ops/audit-chain`                                                 | `ADMIN`, `SUPPORT` | son doğrulama durumu; salt okunur. Triyajın ilk sorusu "denetim izi sağlam mı" olabilir   |
| `POST /ops/audit-chain/verify`                                         | `ADMIN`            | iş yükü üretir ve checkpoint yazar; audit satırlarını değiştirmez                         |
| `POST /ops/retention/sweep`                                            | `ADMIN`            | **veri siler** — `SUPPORT` yıkıcı işlem yapamaz (ADR-0013 §4)                             |

## İstemci bütünlüğü katmanı (App Check)

Guard sırası: **oran sınırı → App Check → kimlik → rol → kullanıcı kotası** (ADR-0022).
App Check yetkilendirme değildir; bu tablodaki hiçbir kuralın yerine geçmez, yalnızca
önüne eklenir. `@SkipAppCheck()` yalnızca istemci uygulamasından gelmeyen uçlara
uygulanır: `POST /payments/webhook`, `POST /verification/callback`, `GET /health/*`.
Bu uçların doğrulama modeli HMAC imzasıdır.

## Veri erişim katmanı

Yetki kontrolü yalnızca controller'da değil, sorgularda da uygulanır: profil okuma/güncelleme
sorguları `WHERE user_id = $1` ile kapsanır. Guard atlanmış bir kod yolu bile başka kullanıcının
verisini döndüremez (ADR-0013 §3).

## Sonraki fazlarda genişleyecek

| Faz | Eklenecek                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3   | verification endpoint'leri; `VERIFICATION_REQUIRED` ile seviye bazlı yetki                                                                                                      |
| 4   | booking sahipliği (müşteri ↔ sağlayıcı iki taraflı erişim), state machine yetkileri                                                                                             |
| 5   | ✅ ödeme ve dispute aksiyonları eklendi; `SUPPORT` kısıtları Faz 10 admin API testleriyle doğrulandı                                                                            |
| 7   | ✅ eşleştirme uçları eklendi; skor bileşenleri `ADMIN` dışına kapalı (T-19)                                                                                                     |
| 8   | ✅ safety uçları eklendi; ham konum yalnızca `ADMIN` + audit, iç risk mantığı taraflara kapalı                                                                                  |
| 10  | ✅ admin/ops endpoint'leri eklendi (yukarıdaki tablo); `SUPPORT` her alt kapsamda read-only doğrulandı (`admin.integration.spec.ts`)                                            |
| 12  | ✅ App Check zorunluluğu (`@SkipAppCheck()` istisnaları), kullanıcı başına oran sınırı, ops audit-chain/retention uçları; kurtarma onayında **bağımsız operatör** kuralı (R-36) |
| 13  | Cloud SQL rol ayrımı (migration ≠ uygulama kullanıcısı, T-35); IAM least privilege                                                                                              |
