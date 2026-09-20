# ADR-0006 — Merkezî Booking State Machine + History

- Durum: Accepted (2026-09-20)
- Faz: 4
- Blueprint: §12, §7.1

## Bağlam

Booking yaşam döngüsü 12 ana durum ve 3 yan durum içeriyor; ödeme, safety ve bildirim akışları bu
durumlara bağlı. Durum geçişleri controller/service kodunun içine dağılırsa geçersiz geçişler
kaçınılmaz olur ve audit izi eksik kalır.

## Karar

1. Durumlar PostgreSQL **ENUM** (veya referans tablo + FK) ile tiplenir; serbest `VARCHAR` kullanılmaz.
   ```
   REQUESTED → MATCHED → PROVIDER_PENDING → CONFIRMED → PAYMENT_AUTHORIZED → SCHEDULED
   → PROVIDER_ARRIVING → CHECKED_IN → IN_PROGRESS → CHECKED_OUT → CUSTOMER_CONFIRMED
   → COMPLETED → SETTLED
   yan: CANCELLED | DISPUTED | SAFETY_HOLD
   ```
2. İzin verilen geçişler **tek bir transition map**'te tanımlanır (`bookings/state/transitions.ts`).
   Her geçiş için: kaynak durum, hedef durum, izinli aktör rolleri, ön koşullar (guard), yan etkiler.
3. Geçiş tek bir `BookingStateService.transition()` üzerinden yapılır. Booking status'u başka hiçbir
   yerden UPDATE edilmez. Kural lint/review ile korunur.
4. Her geçiş aynı DB transaction'ında `booking_status_history`'ye yazılır
   (`from_status`, `to_status`, `changed_by`, `reason`, `created_at`). History append-only'dir.
5. Geçişler **idempotent**: aynı komut iki kez gelirse (retry, çift tıklama, duplicate event)
   ikinci çağrı yan etki üretmez. `idempotency_keys` tablosu (ADR-0003) + `SELECT ... FOR UPDATE`
   veya optimistic versiyon kolonu kullanılır. Idempotency kaydı yan etkiyle aynı transaction'da.
6. `SAFETY_HOLD` ve `DISPUTED` **ödeme serbest bırakmayı bloklar**; bu kural state machine guard'ında
   tanımlıdır, ödeme modülünün insafına bırakılmaz.
7. **Booking aggregate root'tur.** Ödeme durumu booking'in yanında yaşayan bir projeksiyondur
   (ADR-0009): çelişki durumunda booking state machine guard'ları belirleyicidir ve payment durumu
   PSP event'lerinden mutabakatla düzeltilir — tersi değil.
8. Çakışma engeli: `EXCLUDE USING GIST` constraint,
   `(provider_id WITH =, tstzrange(scheduled_start, scheduled_end) WITH &&)`
   **`WHERE status NOT IN ('CANCELLED','DISPUTED_CANCELLED', ...)`** predikatıyla.
   Predikat olmadan iptal edilmiş bir booking, o zaman aralığını provider'ın takviminde kalıcı
   olarak bloklar. İptal edilmiş sayılan durumların listesi migration'da açıkça yazılır ve
   testle doğrulanır. Redis lock yalnızca gereksiz çakışma denemelerini azaltan optimizasyondur;
   doğruluğun tek kaynağı constraint'tir.
9. **Diğer zorunlu DB invariant'ları:**
   - `CHECK (customer_id <> provider_id)` — tek User/iki profil modeli kendi kendine booking'e
     izin verir; bu GMV, review ve ESG metriklerini manipüle etme yoludur (ADR-0004 §9).
   - `CHECK (scheduled_end > scheduled_start)`, `CHECK (price_minor >= 0)`.
   - `reviews` üzerinde `CHECK (reviewer_id <> reviewee_id)` — blueprint §8'deki
     `UNIQUE (booking_id, reviewer_id, reviewee_id)` kendi kendine review'u engellemez.
   - `provider_id` yalnızca `MATCHED` ve sonrası durumlarda zorunludur; `REQUESTED` durumunda
     NULL olabilir (bkz. risk R-14 — nihai tasarım Faz 4 ADR'siyle kapanır).

## Gerekçe

Merkezî transition map, geçersiz geçişleri kod incelemesine değil tipe ve teste bağlar.
History aynı transaction'da yazılmazsa audit izi güvenilmez olur.

## Sonuçlar

- Yeni durum eklemek migration + transition map + test gerektirir; sessizce eklenemez.
- Test zorunlu: geçersiz geçiş reddi (T-06), eşzamanlı çift booking (T-05), iptal sonrası aynı
  slota yeni booking (T-05b), kendi kendine booking reddi (T-05c), idempotent tekrar çağrı (T-07),
  SAFETY_HOLD'da settlement bloğu (T-11).

## Uygulama notu (Faz 4) — R-14 kararı

**`bookings.provider_id` nullable'dır ve zorunluluğu duruma bağlıdır.**

Blueprint'teki taslak DDL `provider_id NOT NULL` diyordu; bu, `REQUESTED` durumuyla
çelişiyordu (talep oluştuğunda sağlayıcı henüz seçilmemiştir — eşleştirme Faz 7'de
yapılacak). Üç seçenek değerlendirildi:

1. Booking'i yalnızca eşleşme sonrası oluşturmak → talebin kendi yaşam döngüsü
   (`booking_requests`) ile booking'in yaşam döngüsü karışır; `REQUESTED` durumu anlamsızlaşır.
2. Sağlayıcıyı "atanmamış" temsil eden bir sentinel satır → yabancı anahtar semantiğini bozar.
3. **Seçilen:** `provider_id` nullable + `CHECK (status = 'REQUESTED' OR provider_id IS NOT NULL)`.
   Böylece "sağlayıcısız booking" yalnızca tek bir durumda mümkündür ve bu veritabanında
   zorlanır. `EXCLUDE` constraint'i de `provider_id IS NOT NULL` koşuluyla çalışır.

**Diğer uygulama detayları:**

- **Redis distributed lock uygulanmadı.** ADR bunu "optimizasyon" olarak tanımlıyordu;
  uygulamada da gerçekten gereksiz çıktı: çakışmayı `EXCLUDE` constraint'i tek başına,
  tüm eşzamanlılık senaryolarında engelliyor. Lock eklemek doğruluğa bir şey katmaz ama
  yeni bir arıza modu (Redis yokken ne yapılacağı) getirirdi. Bu yüzden T-05e "Redis
  erişilemezken doğruluk korunur" testi, lock'ın yokluğunu değil constraint'in yeterliliğini
  doğrular. Lock, ölçüm gerçek bir çakışma maliyeti gösterirse eklenir.
- Çakışma engeli `EXCLUDE USING GIST (provider_id WITH =, slot WITH &&) WHERE (status <> 'CANCELLED' ...)`.
  `btree_gist` extension'ı gerekir (UUID eşitliği GIST içinde desteklenmez).
  `slot` kolonu `tstzrange(start, end, '[)')` olarak **türetilmiştir**: uçlarla aralık
  birbirinden ayrışamaz ve bitişik randevular (biri bitince diğeri başlar) çakışma saymaz.
- `booking_status_history` append-only trigger'ı ile korunur; ilk kayıt (`REQUESTED`)
  booking oluşturulurken yazılır.
- Aktör, global rolden değil **bu rezervasyondaki konumdan** türetilir: aynı kişi hem müşteri
  hem sağlayıcı olabilir (ADR-0004), bu yüzden "PROVIDER rolüm var" bir rezervasyonda
  sağlayıcı olmak anlamına gelmez.
- Taraf olmayan kullanıcıya rezervasyonun **varlığı** bildirilmez (403 değil 404).
- Hizmet günü geçişleri tek endpoint (`POST /bookings/:id/transitions`) üzerinden ilerler;
  hangi geçişin geçerli olduğunu transition map söyler. Geçiş başına endpoint yazmak,
  kuralları HTTP katmanına yeniden dağıtmak olurdu.

**Faz 4 review düzeltmeleri:**

- **`ADMIN` sahiplik kapısından geçer.** Operatörün müdahale etmesi gereken geçişler
  (güvenlik askısından çıkarma, uyuşmazlık kararı) tanımı gereği üçüncü taraf aksiyonudur;
  sahiplik kapısı admin'i de eleseydi bu geçişler hiç tetiklenemezdi. Admin aksiyonları
  audit'e yazılır ve taraf olmayan **admin olmayan** kullanıcı yine 404 alır.
- **Hizmet sırasında iptal operatöre açıldı.** Güvenlik dışı bir aksaklıkta (ekipman arızası,
  müşteri evde değil) rezervasyonun sıkışmaması gerekir: `CHECKED_IN`/`IN_PROGRESS`/`CHECKED_OUT`
  → `CANCELLED` yalnızca `ADMIN` aktörüne açıktır. Taraflar hâlâ iptal edemez; para akışı
  dispute/refund ile çözülür (Faz 5).
- **Fiyat istemciden alınmaz.** Rezervasyon fiyatı katalogdan sunucuda hesaplanır: istemci
  tutar gönderebildiği sürece müşteri (veya anlaşmalı müşteri-sağlayıcı çifti) keyfî düşük
  bir tutar kaydedip komisyon ve GMV metriklerini manipüle edebilirdi. HOURLY hizmetlerde
  ücret dakika bazında oranlanır (90 dakika, 2 saat ücreti ödemez).
- **Müsaitlik kontrolü transaction içinde ve kilitli.** Kontrol transaction dışında yapılsaydı
  sağlayıcı aradan pencereyi silebilir ve rezervasyon beyan edilmiş saatlerin dışına düşebilirdi
  (TOCTOU). `FOR SHARE` pencereyi commit'e kadar silinmekten korur; çakışmayı EXCLUDE garanti eder.
- **CHECK ihlalleri kodlu hataya çevrilir.** Yalnızca `bookings_not_self` çevriliyordu; diğer
  invariant ihlalleri ham Postgres hatası olarak 500'e dönüşüyordu.

## Alternatifler

- **Serbest status string (reddedildi):** geçersiz durum yazılabilir.
- **Harici workflow motoru (ertelendi):** bu ölçekte gereksiz bağımlılık.
