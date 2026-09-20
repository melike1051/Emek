# ADR-0004 — 1 İnsan = 1 User, DB Seviyesinde Tekil Kimlik

- Durum: Accepted (2026-09-20)
- Faz: 3
- Blueprint: §7.2, §10, §10.2, §10.3

## Bağlam

Pazaryerinde güven, kişinin tekilliğine dayanır. Kötü review alan bir sağlayıcının yeni e-posta ve
telefonla ikinci doğrulanmış hesap açması trust sistemini çökertir. Aynı kişi hem müşteri hem
sağlayıcı olabilmeli — ama iki ayrı hesapla değil.

## Karar

1. **Tek `users` kaydı kişi başına.** Roller `user_roles`, profiller `customer_profiles` ve
   `provider_profiles` tablolarında; ikisi aynı `user_id`'yi paylaşabilir.
2. **Tekillik veritabanında zorlanır.** `identity_records` üzerinde:
   - `identity_hash` üzerinde **sağlayıcıdan bağımsız** partial unique index
     (`UNIQUE (identity_hash) WHERE identity_hash IS NOT NULL`) — **birincil tekillik kontrolü budur.**
   - `UNIQUE (verification_provider, provider_subject_id)` — aynı sağlayıcının aynı subject'ini
     ikinci kez bağlamayı engeller. Bu kısıt **tek başına yeterli değildir**: sağlayıcıya göre
     kapsamlıdır, dolayısıyla aynı kişi A sağlayıcısıyla doğrulanıp sonra B sağlayıcısıyla
     doğrulanırsa çakışma üretmez. Sağlayıcı değiştirerek ikinci hesap açma yolunu yalnızca
     `identity_hash` kapatır.
   - `UNIQUE (user_id)` — bir kullanıcının tek doğrulanmış kimlik kaydı olur.
     Uygulama kontrolü ilk savunma, DB constraint son savunmadır; yarış koşulunda tek koruma DB'dir.
3. **`identity_hash` zorunludur.** `IDENTITY_VERIFIED` ve üzeri seviye, hash üretilmeden verilmez.
   Ulusal kimlik numarasından türetilmiş deterministik bir referans üretemeyen bir sağlayıcı,
   tekillik kontrolü gerektiren akışlarda (kayıt, provider onayı, recovery) **tek başına
   kullanılamaz**; yalnızca ek sinyal olur.
4. **Ham kimlik numarası saklanmaz.** `identity_hash`, ham kimlik verisini gören **tek bileşen olan
   adapter sınırının içinde** üretilir (ADR-0005); ham değer core domain'e hiç geçmez.
   Algoritma: Cloud KMS'te tutulan, **dışa çıkarılamaz (non-exportable)** anahtarla
   **HMAC-SHA256**. Düz `SHA256(TCKN)` **yasaktır** — 11 haneli uzay brute-force ile tersine çevrilebilir.
5. **HMAC anahtarı rotasyona tabi değildir.** Ham girdi bilinçli olarak saklanmadığı için mevcut
   hash'ler yeniden hesaplanamaz; anahtar değişirse aynı kişi farklı hash üretir ve tekillik
   **sessizce** çalışmaz hale gelir. Bu nedenle:
   - Anahtar KMS'te non-exportable olarak oluşturulur, otomatik rotasyon **kapalıdır**.
   - `identity_records.hash_key_version` yine tutulur, ancak amacı rotasyon değil **teşhis**tir:
     hangi kayıt hangi anahtar sürümüyle üretildi.
   - Anahtar bir güvenlik olayı nedeniyle değişmek zorunda kalırsa tek geçerli yol
     **kullanıcıların yeniden doğrulanmasıdır** (re-verification migration). Bu senaryonun
     prosedürü Faz 12'de yazılır; "anahtarı döndürüp devam etmek" bir seçenek değildir.
   - Anahtar kaybı tekillik kontrolünü kırar (risk R-12): erişim ayrımı ve KMS yedekliliği kritik yoldadır.
6. **Verification seviyeleri:** `UNVERIFIED → PHONE_VERIFIED → IDENTITY_VERIFIED →
PROVIDER_VERIFIED → FULLY_VERIFIED`. Müşteri için `IDENTITY_VERIFIED` yeterli olabilir;
   sağlayıcı için ek belge/yetkinlik/safety onboarding gerekir.
7. **Account recovery, mükerrer hesap engelinin zorunlu karşılığıdır.** Aynı kimlik referansı
   bulunduğunda yeni hesap açılmaz; mevcut User'a ek doğrulama ile dönülür. Recovery akışı
   identity doğrulamadan **ayrı** tasarlanır ve her adımı `audit_logs`'a yazılır.
8. "Doğrulanmış kimlik" rozeti ile "adli sicil temiz" gibi iddialar **farklı** alanlardır ve
   birbirinin yerine kullanılamaz.
9. **Tek User / iki profil modelinin yan etkisi:** aynı kişi hem müşteri hem sağlayıcı olabildiği
   için kendi kendine booking açıp GMV, review ve ESG metriklerini şişirebilir. `bookings` üzerinde
   `CHECK (customer_id <> provider_id)` ve `reviews` üzerinde `CHECK (reviewer_id <> reviewee_id)`
   zorunludur (ADR-0006).

## Gerekçe

Tekillik sadece uygulama katmanında kontrol edilirse iki eşzamanlı kayıt isteği kontrolü geçip
ikisi de yazabilir. Veri minimizasyonu (ham TCKN yerine referans/hash) KVKK yükümlülüğünü
ortadan kaldırmaz ama ihlal yüzeyini küçültür.

## Sonuçlar

- Recovery akışı sosyal mühendislik hedefi olur: ek doğrulama, oran sınırı, tam audit zorunlu (Faz 3 + 12).
- Hash anahtarı kaybı veya değişimi tekillik kontrolünü kırar → KMS anahtar yönetimi kritik yol
  üzerindedir ve rotasyon bir seçenek değildir (bkz. karar §5, risk R-12).
- Hash üretemeyen bir sağlayıcı tekillik gerektiren akışlarda kullanılamaz; sağlayıcı seçim
  kriterine "deterministik kimlik referansı üretebilme" eklenir.
- Test zorunlu: eşzamanlı çift kayıt denemesi (T-01), sağlayıcı değiştirerek ikinci hesap denemesi (T-01b).

## Alternatifler

- **Uygulama seviyesinde tekillik (reddedildi):** yarış koşulunda yetersiz.
- **Ham TCKN saklama (reddedildi):** gereksiz risk, blueprint ve KVKK rehberine aykırı.
- **Düz hash (reddedildi):** küçük giriş uzayı nedeniyle tersine çevrilebilir.
