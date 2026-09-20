# ADR-0017 — Ödeme Veri Modeli: Canlı Ödeme, Giden Komut ve İade

- Durum: Accepted (2026-09-20)
- Faz: 5
- İlgili: ADR-0009 (lisanslı ödeme kuruluşu), ADR-0003 (PostgreSQL tek kaynak), ADR-0006 (booking state machine)

## Bağlam

ADR-0009 §"Sonuçlar" şunu açık bırakmıştı:

> `payments.booking_id UNIQUE` kısmi iade veya çoklu intent senaryosunu kilitler;
> Faz 5'te `payment_intents` ayrımı değerlendirilir ve karar ADR olarak yazılır.

Faz 5'te üç somut senaryo bu kararı zorladı:

1. **Başarısız yetkilendirme.** Kart reddedilirse müşteri tekrar denemek ister. Düz
   `UNIQUE (booking_id)` ile ilk başarısız satır yerinde kalır ve rezervasyon kalıcı
   olarak ödenemez hâle gelir.
2. **Kısmi iade.** Uyuşmazlık kararı "hizmetin yarısı yapılmış" olabilir; tutarın bir
   kısmı iade edilir, kalanı sağlayıcıya gider.
3. **Çift giden çağrı.** `payment_events.external_event_id` UNIQUE yalnızca **gelen**
   webhook'u tekilleştirir. Süreç `authorize` çağrısını gönderdikten sonra çökerse,
   yeniden denemede ikinci bir yetkilendirme oluşabilir — bu doğrudan finansal hatadır.

## Karar

### 1. Ayrı bir `payment_intents` tablosu **yoktur**

Intent, ödemenin bir aşamasıdır (`status = 'CREATED'`), ayrı bir varlık değil. Ayrı tablo
iki tabloyu senkron tutma yükümlülüğü getirir ve "hangisi doğru?" sorusunu üretir.
Sağlayıcıdaki intent referansı `payments.external_payment_id` kolonunda taşınır.

### 2. Rezervasyon başına **bir canlı ödeme** — kısmi unique index

```sql
CREATE UNIQUE INDEX uq_payments_live_per_booking
  ON payments (booking_id)
  WHERE status NOT IN ('FAILED', 'AUTHORIZATION_EXPIRED', 'REFUNDED');
```

Aynı anda birden fazla canlı ödeme olamaz (çift hold yok), ama sonuçlanmış başarısız
denemeler yeni bir denemeyi engellemez. Düz `UNIQUE` bu ikisini aynı anda sağlayamazdı.

### 3. Kısmi iade ayrı tablo değil, **biriktirilen toplam**

`payments.refunded_minor` + `CHECK (refunded_minor <= amount_minor)`. Her iade ayrıca
`payment_commands` (giden çağrı) ve gerekirse `payment_events` (sağlayıcı bildirimi)
kaydı bırakır — yani iade geçmişi kaybolmaz, yalnızca ayrı bir `refunds` tablosunda
tutulmaz. Kısmi iade ödemenin durumunu **değiştirmez**: ödeme canlı kalır. Tutarın
tamamı iade edildiğinde durum `REFUNDED` olur.

> Faz 11 mutabakatı sağlayıcı raporuyla `refunded_minor` toplamını karşılaştırır;
> ayrı satır gerekirse `payment_commands` zaten satır bazlı geçmişi taşır.

### 4. Giden çağrılar için `payment_commands`

Her `authorize`/`reauthorize`/`capture`/`refund` çağrısı **gönderilmeden önce** bir satır
rezerve eder:

```sql
CONSTRAINT payment_commands_unique_key UNIQUE (idempotency_key),
CONSTRAINT payment_commands_unique_attempt UNIQUE (payment_id, operation, attempt)
```

Anahtar deterministiktir: `sha256(paymentId:OPERATION:attempt)`. Bu iki katman sağlar:

- **Emek tarafı:** ikinci çağrı denemesi UNIQUE ihlaliyle durur (T-38).
- **Sağlayıcı tarafı:** aynı anahtarla giden çağrı sağlayıcının kendi idempotency
  mekanizmasıyla da elenir.

**Her işlemin kendi anahtarı vardır.** Faz 5 geliştirmesinde `createIntent` ve `authorize`
aynı anahtarı paylaşıyordu; sağlayıcı sözleşmesi gereği ikinci çağrıya **birincinin
sonucunu** döndürdü, yani yetkilendirme hiç yapılmadı ve ödeme yarım kaldı. Bu yüzden
`CREATE_INTENT` ve `AUTHORIZE` ayrı anahtarlar kullanır.

### 5. Ödeme durumu booking'in projeksiyonudur ama yalanlanamaz

ADR-0009 §3 booking'i aggregate root ilan eder. Faz 5 buna iki yönlü bir kapı ekler:

- Booking `SETTLED` olmadan önce `PaymentsService.assertSettlementAllowed` çağrılır:
  para serbest bırakılmamışsa geçiş reddedilir. Aksi halde hiç para çıkmamışken
  "mutabakatlandı" görünen rezervasyonlar üretilebilirdi.
- Booking `COMPLETED`/`DISPUTED`/`SAFETY_HOLD` olduğunda ödeme durumu ilerletilir
  veya dondurulur — ama **para hareketi başlatılmaz**.

Modül döngüsünü kırmak için `BookingStateService` paylaşılan `BookingStateModule`'e
taşındı; geçişin tek yol olma özelliği korunur.

### 6. Blok gerekçesi commit edilir, hata dışarıda üretilir

Release bloklandığında (`PAYMENT_RELEASE_BLOCKED`, `PAYMENT_AUTHORIZATION_EXPIRED`)
gerekçe `audit_logs`'a yazılır. Exception transaction **içinde** fırlatılsaydı rollback
ile birlikte bu kayıt da kaybolurdu — "neden bloklandı" hiç kaydedilmezdi. Karar
transaction'dan dönülür, commit edilir, hata sonra üretilir. (Aynı hata Faz 3'te kimlik
reddetme akışında görülmüş ve aynı desenle çözülmüştü.)

### 7. Dondurulmuş ödeme çözülebilir olmak zorundadır

Uyuşmazlık veya güvenlik askısı ödemeyi `DISPUTED` yapar. `payments.frozen_from_status`
dondurma öncesi durumu saklar ve çözümde oraya dönülür:

- Hizmet sırasında askıya alınmış ödeme → `HELD` → akış normal devam eder.
- Tamamlandıktan sonra açılan uyuşmazlık çözülünce → `SERVICE_COMPLETED` → release mümkün.

Bu kolon olmasaydı tek bir geri dönüş durumu seçmek zorunda kalırdık ve diğer senaryoda
para kilitlenirdi: sağlayıcı lehine karar verilmiş bir uyuşmazlıkta bile hizmeti tamamlamış
sağlayıcının parası ne serbest bırakılabilir ne iade edilebilirdi (iade müşteriye gider).
Çözüm, başka bir **açık** uyuşmazlık varsa yapılmaz: ilk karar ikinciyi geçersiz kılamaz.

### 8. Kabul edilen yarış penceresi: guard ile capture arasında

Release guard'ları (uyuşmazlık, güvenlik askısı, süre) bir transaction içinde satır
kilidiyle çalışır ve **commit edilir**; sağlayıcı çağrısı bundan sonra, transaction
dışında yapılır. Bu pencerede yeni bir uyuşmazlık açılabilir veya güvenlik askısı konabilir
— capture zaten gönderilmiş olur ve geri alınamaz.

Bu bilinçli bir kabuldür: alternatif, PSP ağ çağrısını veritabanı transaction'ının içinde
tutmak olurdu ve PSP yavaşladığında bağlantı havuzu ile kilitler tükenirdi. Telafi yolu
**iadedir**: bu pencerede açılan uyuşmazlık, kararı iade ile uygulanır (`refund`, kısmi
veya tam). Pencere `RELEASE_PENDING` durumu sayesinde görünürdür ve mutabakat işinin
(Faz 11) girdisidir.

## Sonuçlar

- Sağlayıcı çağrısı transaction **dışında** yapılır: PSP yavaşladığında veritabanı
  bağlantıları ve kilitleri bloklanmaz. Doğruluğu `payment_commands` rezervasyonu korur.
- Çağrı gönderildikten sonra süreç çökerse komut satırı `PENDING` kalır ve ödeme
  `RELEASE_PENDING` durumunda görünür: "gönderildi mi bilinmiyor" hâli **kayıt altındadır**
  ve Faz 11 mutabakat işinin girdisidir. Bu bilinçli bir izdir, boşluk değil.
- Kart verisi hiçbir kolonda yoktur; şema seviyesinde test edilir.

## Alternatifler

- **`payment_intents` ayrı tablo (reddedildi):** iki tabloyu senkron tutma yükümlülüğü,
  ek transaction sınırları ve "hangisi doğru?" belirsizliği; kazancı yok.
- **`refunds` ayrı tablo (şimdilik reddedildi):** `payment_commands` zaten satır bazlı
  iade geçmişini taşıyor. Çok taraflı payout (Faz 11) gerekirse yeniden değerlendirilir.
- **Giden idempotency'yi Redis'te tutmak (reddedildi):** Redis flush'ı çift yetkilendirme
  üretirdi; para kararları kalıcı veriye dayanmalı (ADR-0003).
