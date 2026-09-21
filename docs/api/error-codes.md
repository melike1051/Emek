# Business Error Codes

Kullanıcıya dönen her iş hatası bir koda sahiptir. Ham exception mesajı, stack trace veya SQL
hatası **hiçbir koşulda** client'a dönmez. Yeni kod eklenince bu tablo güncellenir.

Yanıt formatı:

```json
{
  "error": {
    "code": "BOOKING_CONFLICT",
    "message": "Seçilen zaman aralığı artık uygun değil.",
    "requestId": "uuid",
    "details": {}
  }
}
```

`message` kullanıcıya gösterilebilir, güvenli metindir. `details` yalnızca istemcinin ihtiyaç
duyduğu yapısal bilgiyi taşır (ör. hangi alan geçersiz) — iç sistem detayı taşımaz.

**Mesaj asla exception içeriğinden türetilmez.** Domain hataları (`BusinessException`) kendi
istemci mesajını açıkça verir; diğer tüm hatalarda mesaj sabit listeden gelir
(`services/api/src/common/errors/error-codes.ts` → `CLIENT_MESSAGES`). Böylece framework metinleri
("Cannot GET /api/v1/x"), SQL hataları ve stack trace'ler sözleşmeye sızmaz.

Uygulama durumu: altyapı seviyesindeki kodlar Faz 1'de tanımlıdır (aşağıdaki tabloda Faz 1/2
işaretli olanlar); domain kodları kendi fazında, ilgili modülle birlikte eklenir.

| Kod                                 | HTTP | Anlam                                                           | Faz  |
| ----------------------------------- | ---- | --------------------------------------------------------------- | ---- |
| `VALIDATION_FAILED`                 | 400  | İstek şeması/alan doğrulaması başarısız                         | 1 ✅ |
| `UNAUTHENTICATED`                   | 401  | Geçerli token yok veya süresi dolmuş                            | 1 ✅ |
| `FORBIDDEN`                         | 403  | Rol veya ownership yetkisi yok                                  | 1 ✅ |
| `NOT_FOUND`                         | 404  | Kaynak yok veya erişilemez (varlık sızdırılmaz)                 | 1 ✅ |
| `RATE_LIMITED`                      | 429  | Oran sınırı aşıldı                                              | 1 ✅ |
| `APP_INTEGRITY_FAILED`              | 403  | App Check doğrulaması başarısız                                 | 12   |
| `VERIFICATION_REQUIRED`             | 403  | İşlem için gereken doğrulama seviyesi yok                       | 3    |
| `IDENTITY_ALREADY_REGISTERED`       | 409  | Bu kimlik referansı başka bir hesaba bağlı → recovery akışı     | 3    |
| `VERIFICATION_SESSION_EXPIRED`      | 409  | Doğrulama oturumu süresi doldu                                  | 3    |
| `VERIFICATION_FAILED`               | 422  | Sağlayıcı doğrulamayı reddetti                                  | 3    |
| `RECOVERY_NOT_ALLOWED`              | 403  | Recovery ön koşulları sağlanmadı                                | 3    |
| `PROVIDER_NOT_AVAILABLE`            | 409  | Sağlayıcı istenen aralıkta müsait değil                         | 4    |
| `BOOKING_CONFLICT`                  | 409  | Çakışan rezervasyon var                                         | 4    |
| `INVALID_STATE_TRANSITION`          | 409  | Bu durumdan hedef duruma geçiş tanımlı değil                    | 4    |
| `BOOKING_NOT_MODIFIABLE`            | 409  | Booking mevcut durumunda değiştirilemez                         | 4    |
| `SELF_BOOKING_NOT_ALLOWED`          | 422  | Aynı kullanıcı kendi hizmetini rezerve edemez                   | 4    |
| `PAYMENT_FAILED`                    | 422  | Ödeme yetkilendirme/çekim başarısız                             | 5 ✅ |
| `PAYMENT_DECLINED`                  | 422  | Sağlayıcı ödemeyi reddetti (bakiye/kart)                        | 5 ✅ |
| `PAYMENT_ALREADY_AUTHORIZED`        | 409  | Bu rezervasyon için canlı bir ödeme zaten var                   | 5 ✅ |
| `PAYMENT_AUTHORIZATION_EXPIRED`     | 409  | Yetkilendirme süresi doldu, yenilenmeli                         | 5 ✅ |
| `PAYMENT_REAUTHORIZATION_EXHAUSTED` | 409  | Yenileme üst sınırına ulaşıldı                                  | 5 ✅ |
| `PAYMENT_ALREADY_RELEASED`          | 409  | Ödeme zaten serbest bırakıldı                                   | 5 ✅ |
| `PAYMENT_RELEASE_BLOCKED`           | 409  | Açık dispute veya `SAFETY_HOLD` nedeniyle release bloklandı     | 5 ✅ |
| `PAYMENT_NOT_RELEASED`              | 409  | Para serbest bırakılmadan `SETTLED` olunamaz                    | 5 ✅ |
| `PAYMENT_COMMAND_IN_FLIGHT`         | 409  | Aynı ödeme komutu hâlâ sürüyor (giden idempotency)              | 5 ✅ |
| `PAYMENT_WEBHOOK_REJECTED`          | 401  | Webhook imzası/gövdesi doğrulanamadı                            | 5 ✅ |
| `DISPUTE_ALREADY_OPEN`              | 409  | Bu booking için açık dispute var                                | 5 ✅ |
| `DISPUTE_NOT_OPEN`                  | 409  | Uyuşmazlık zaten karara bağlanmış                               | 5 ✅ |
| `DISPUTE_WINDOW_CLOSED`             | 409  | Bu rezervasyon durumunda uyuşmazlık açılamaz                    | 5 ✅ |
| `DOCUMENT_NOT_FOUND`                | 404  | Doküman yok veya erişilemez                                     | 5 ✅ |
| `DOCUMENT_ALREADY_UPLOADED`         | 409  | Doküman zaten yüklenmiş ve onaylanmış                           | 5 ✅ |
| `DOCUMENT_INTEGRITY_MISMATCH`       | 422  | Beyan edilen `sha256` storage.daki nesneyle uyuşmuyor           | 5 ✅ |
| `REVIEW_NOT_ALLOWED`                | 409  | Rezervasyon değerlendirmeye uygun durumda değil                 | 5 ✅ |
| `REVIEW_ALREADY_EXISTS`             | 409  | Bu rezervasyonu zaten değerlendirdiniz                          | 5 ✅ |
| `REQUEST_NOT_UNDERSTOOD`            | 422  | Talep yapılandırılamadı, netleştirme gerekiyor                  | 6    |
| `MATCHING_ALREADY_COMPLETED`        | 409  | Talep zaten eşleştirildi; ikinci çalıştırma rezervasyon üretmez | 7 ✅ |
| `MATCHING_REQUEST_NOT_MATCHABLE`    | 409  | Talep eşleştirilebilir durumda değil (iptal/süresi dolmuş)      | 7 ✅ |
| `MATCHING_CONFIDENCE_TOO_LOW`       | 422  | Ayrıştırma güveni eşiğin altında; formla tamamlanmalı           | 7 ✅ |
| `MATCHING_NO_CANDIDATE`             | 409  | Hard constraint'leri geçen aday yok                             | 7 ✅ |
| `MATCHING_RUN_NOT_FOUND`            | 404  | Bu talep için karar kaydı yok                                   | 7 ✅ |
| `PROVIDER_SERVICE_ALREADY_ADDED`    | 409  | Sağlayıcı bu hizmeti zaten beyan etmiş                          | 7 ✅ |
| `SAFETY_SESSION_NOT_ACTIVE`         | 409  | Aktif hizmet oturumu yok; telemetri kabul edilmez               | 8    |
| `TELEMETRY_REJECTED`                | 422  | Zaman sapması, sıra numarası veya bütünlük kontrolü başarısız   | 8    |
| `SERVICE_DEGRADED`                  | 503  | Bağımlı servis erişilemez; kısmi/fallback sonuç mümkün          | 1 ✅ |
| `INTERNAL_ERROR`                    | 500  | Beklenmeyen hata; iç detay sızdırılmaz                          | 1 ✅ |
| `IDEMPOTENCY_KEY_REUSED`            | 409  | Aynı idempotency key farklı içerikle kullanıldı                 | 4    |

## Kurallar

- Kod adı `SCREAMING_SNAKE_CASE`, kararlıdır; anlamı değişirse yeni kod eklenir, eskisi yeniden kullanılmaz.
- Kodlar istemci davranışını yönlendirmek için vardır; kullanıcı metni istemcide yerelleştirilir.
- Varlığın var olup olmadığını sızdırmamak için yetkisiz erişimde `NOT_FOUND` tercih edilir
  (kaynağın varlığı bilgi sızıntısıysa).
