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

| Endpoint                                                           | Kimlik                                      | Rol                        | Sahiplik                          | Not                                                      |
| ------------------------------------------------------------------ | ------------------------------------------- | -------------------------- | --------------------------------- | -------------------------------------------------------- |
| `GET /health`, `GET /health/live`                                  | ❌ açık                                     | —                          | —                                 | orchestrator çağırır                                     |
| `POST /auth/session`                                               | token doğrulanır, Emek kullanıcısı gerekmez | —                          | —                                 | oran sınırı: 20/dk                                       |
| `GET /users/me`                                                    | ✅                                          | —                          | kendi kaydı                       |                                                          |
| `PATCH /users/me`                                                  | ✅                                          | —                          | kendi kaydı                       | e-posta/telefon E.164 doğrulanır                         |
| `GET /users/me/roles`                                              | ✅                                          | —                          | kendi rolleri                     |                                                          |
| `POST /customers/profile`                                          | ✅                                          | `CUSTOMER`                 | kendi profili                     |                                                          |
| `GET`/`PATCH /customers/me`                                        | ✅                                          | `CUSTOMER`                 | kendi profili                     |                                                          |
| `POST /providers/profile`                                          | ✅                                          | — (rol bu işlemle verilir) | kendi profili                     | `DRAFT` durumunda başlar                                 |
| `GET`/`PATCH /providers/me`                                        | ✅                                          | `PROVIDER`                 | kendi profili                     |                                                          |
| `GET`/`POST /providers/me/skills`                                  | ✅                                          | `PROVIDER`                 | kendi yetkinlikleri               |                                                          |
| `DELETE /providers/me/skills/:skillId`                             | ✅                                          | `PROVIDER`                 | kendi yetkinliği                  | yol parametresi sahibi belirtmez                         |
| `GET /service-categories`, `/services`, `/services/:id`, `/skills` | ❌ açık                                     | —                          | —                                 | referans veri, PII yok; oran sınırı: 120/dk              |
| `POST /bookings/:id/payment`                                       | ✅                                          | —                          | **yalnızca müşteri**              | tutar rezervasyondan; istemci tutar göndermez            |
| `GET /bookings/:id/payment`                                        | ✅                                          | —                          | rezervasyonun tarafı              | sağlayıcı referansı yanıtta yoktur                       |
| `POST /payments/:id/release`, `/refund`, `/reauthorize`            | ✅                                          | `ADMIN`                    | —                                 | taraflar parayı kendileri hareket ettiremez              |
| `POST /payments/webhook`                                           | ❌ açık — **imza doğrulanır**               | —                          | —                                 | ADR-0009 §7; imzasız çağrı 401, oran sınırı: 300/dk      |
| `POST`/`GET /bookings/:id/disputes`                                | ✅                                          | —                          | rezervasyonun tarafı              | açmak taraflara açıktır                                  |
| `POST /disputes/:id/resolve`                                       | ✅                                          | `ADMIN`                    | —                                 | taraf kendi lehine karar veremez                         |
| `POST /documents`, `/documents/:id/confirm`                        | ✅                                          | —                          | rezervasyonun tarafı              | dosya API'den geçmez; imzalı URL                         |
| `GET /documents/:id/download-url`                                  | ✅                                          | —                          | taraf veya sahibi (`ADMIN` dâhil) | kısa ömürlü imzalı URL; her erişim audit'li              |
| `GET /bookings/:id/documents`                                      | ✅                                          | —                          | rezervasyonun tarafı              |                                                          |
| `POST /bookings/:id/review`                                        | ✅                                          | —                          | rezervasyonun tarafı              | yalnızca `COMPLETED`/`SETTLED`; bir kez                  |
| `GET /users/:id/reviews`                                           | ✅                                          | —                          | —                                 | yazar kimliği yanıtta yoktur                             |
| `POST /booking-requests/from-text`                                 | ✅                                          | —                          | kendi adresi                      | ham metin saklanır, audit'e yazılmaz; oran sınırı: 20/dk |
| `POST /booking-requests`                                           | ✅                                          | —                          | kendi adresi                      | form yolu; AI servisine hiç dokunmaz (T-15)              |
| `GET /booking-requests/:id`                                        | ✅                                          | —                          | kendi talebi                      | sahibi olmayan 404 alır                                  |
| `POST /booking-requests/:id/match`                                 | ✅ sahibi                                   | —                          | kendi talebi                      | başkasının talebi 404; rezervasyon oluşturur             |
| `GET /booking-requests/:id/match`                                  | ✅ sahibi                                   | —                          | kendi talebi                      | yalnızca **seçilen** sağlayıcı döner (T-19)              |
| `POST /matching/runs`                                              | —                                           | —                          | `ADMIN`                           | toplu eşleştirme; başkaları adına rezervasyon oluşturur  |
| `GET /matching/runs/:requestId`                                    | —                                           | —                          | `ADMIN`                           | tam sıralama + skor bileşenleri yalnızca burada          |
| `GET/POST/DELETE /providers/me/services`                           | —                                           | ✅ kendi                   | —                                 | aday havuzunun hizmet kapısı                             |
| `GET/POST/DELETE /providers/me/service-areas`                      | —                                           | ✅ kendi                   | —                                 | merkez + yarıçap; serbest poligon kabul edilmez          |

## Veri erişim katmanı

Yetki kontrolü yalnızca controller'da değil, sorgularda da uygulanır: profil okuma/güncelleme
sorguları `WHERE user_id = $1` ile kapsanır. Guard atlanmış bir kod yolu bile başka kullanıcının
verisini döndüremez (ADR-0013 §3).

## Sonraki fazlarda genişleyecek

| Faz | Eklenecek                                                                                         |
| --- | ------------------------------------------------------------------------------------------------- |
| 3   | verification endpoint'leri; `VERIFICATION_REQUIRED` ile seviye bazlı yetki                        |
| 4   | booking sahipliği (müşteri ↔ sağlayıcı iki taraflı erişim), state machine yetkileri               |
| 5   | ✅ ödeme ve dispute aksiyonları eklendi; `SUPPORT` kısıtları Faz 10 admin API'siyle test edilecek |
| 7   | ✅ eşleştirme uçları eklendi; skor bileşenleri `ADMIN` dışına kapalı (T-19)                       |
| 10  | admin/ops endpoint'leri; hassas veri erişimi için ayrı ve loglanan yetki                          |
| 12  | App Check zorunluluğu, oran sınırı genişletme, abuse senaryoları                                  |
