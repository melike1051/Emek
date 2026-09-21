# Database Schema

Şema ham SQL migration'larla yönetilir (ADR-0014). Migration'lar: `services/api/migrations/`.
Her migration geri alınabilir ve `up → down → up` zinciri CI'da doğrulanır.

## Extension'lar

| Extension  | Neden                                                             |
| ---------- | ----------------------------------------------------------------- |
| `pgcrypto` | `gen_random_uuid()` — UUID birincil anahtarlar                    |
| `postgis`  | Coğrafi tipler ve GIST index'leri (adres, hizmet bölgesi, mesafe) |

Extension'lar `down` yönünde düşürülmez: aynı veritabanını paylaşan başka objeler onlara
bağlı olabilir.

## Migration dosyaları

| Migration                             | İçerik                                                                                       | Faz |
| ------------------------------------- | -------------------------------------------------------------------------------------------- | --- |
| `…120000_shared-updated-at-trigger`   | Paylaşılan `set_updated_at()` fonksiyonu                                                     | 1   |
| `…120100_init-extensions-and-users`   | Extension'lar, `user_status`/`app_role`, `users`, `user_roles`                               | 1   |
| `…130000_audit-logs`                  | `audit_logs` + hash zinciri + değişmezlik trigger'ları + `audit_chain_broken_at()`           | 2   |
| `…130100_outbox-and-idempotency`      | `outbox`, `processed_events`, `idempotency_keys`                                             | 2   |
| `…130200_profiles-and-catalog`        | `customer_profiles`, `provider_profiles`, katalog ve yetkinlik tabloları                     | 2   |
| `…130300_auth-subjects`               | `auth_subjects` (sağlayıcı subject → user eşlemesi)                                          | 2   |
| `…140000_identity`                    | `identity_records`, `verification_attempts`, sağlayıcıdan bağımsız tekil kimlik              | 3   |
| `…140100_deleted-user-contact`        | `users_contact_present` gevşetmesi (silinen kullanıcı)                                       | 3   |
| `…140200_auth-subject-lifecycle`      | `auth_subjects` ACTIVE/REVOKED yaşam döngüsü + kısmi unique                                  | 3   |
| `…140300_account-recovery-requests`   | `account_recovery_requests` (operatör onaylı kurtarma)                                       | 3   |
| `…150000_addresses-and-service-areas` | `addresses`, `provider_service_areas` (PostGIS + GIST)                                       | 4   |
| `…150100_availability`                | `availability`, `availability_exceptions` (EXCLUDE ile örtüşme yasağı)                       | 4   |
| `…150200_bookings`                    | `booking_status`, `booking_requests`, `bookings` (+EXCLUDE), `booking_status_history`        | 4   |
| `…150300_service-pricing`             | `services` fiyatlandırma kolonları + tutarlılık CHECK'leri                                   | 4   |
| `…160000_payments`                    | `payments`, `payment_events`, `payment_commands`                                             | 5   |
| `…160100_disputes`                    | `disputes` (+ açık uyuşmazlık kısmi unique)                                                  | 5   |
| `…160200_documents`                   | `documents` (+ bütünlük trigger'ı)                                                           | 5   |
| `…160300_reviews`                     | `reviews` (+ çift oy ve kendine puan engeli)                                                 | 5   |
| `…160400_payment-freeze-origin`       | `payments.frozen_from_status` (review bulgusu C2)                                            | 5   |
| `…210000_matching` (2026-09-21)       | `provider_services`, `matching_runs`, `booking_match_results`, kapasite, bölge sınırı        | 7   |
| `…220000_safety` (2026-09-22)         | `safety_sessions`, `location_events` (partition), `safety_events`, `safety_risk_assessments` | 8   |

`set_updated_at()` kendi migration'ındadır: birden çok tablo ona bağlanacak ve fonksiyon ilk
kullanan tablonun migration'ına gömülürse o migration'ın `down` yönü sonraki tabloların
trigger'larını kırar. Fonksiyon sabit `search_path` ile tanımlıdır (değiştirilebilir
search_path, trigger fonksiyonlarında bilinen bir ayrıcalık yükseltme yüzeyidir).

## Enum tipleri

Durum alanları serbest metin `VARCHAR` değil, PostgreSQL ENUM'dur — geçersiz durum yazılamaz.

| Tip                   | Değerler                                                                                   | Faz |
| --------------------- | ------------------------------------------------------------------------------------------ | --- |
| `user_status`         | `PENDING`, `ACTIVE`, `SUSPENDED`, `DELETED`                                                | 1   |
| `app_role`            | `CUSTOMER`, `PROVIDER`, `ADMIN`, `SUPPORT`                                                 | 1   |
| `verification_status` | `PENDING`, `VERIFIED`, `REJECTED`, `EXPIRED`                                               | 3   |
| `verification_level`  | `UNVERIFIED`, `PHONE_VERIFIED`, `IDENTITY_VERIFIED`, `PROVIDER_VERIFIED`, `FULLY_VERIFIED` | 3   |

Doğrulama enum'ları **Faz 1'de oluşturulmaz**: onları kullanan ilk tablo `identity_records`
(Faz 3). Enum'ı kullanan tabloyla aynı migration'da oluşturmak, sonradan enum değeri eklemenin
aynı transaction içinde kullanılamaması sorununu da baştan önler. `verification_level`
sıralaması ADR-0004 ile aynı olacak ve testle korunacak — sıra değişimi yetki kararlarını
sessizce bozabilir.

## Tablolar (Faz 1)

### `users`

"1 insan = 1 User" (ADR-0004). Roller ve profiller bu kayda bağlanır.

| Kolon                       | Tip           | Not                      |
| --------------------------- | ------------- | ------------------------ |
| `id`                        | UUID PK       | `gen_random_uuid()`      |
| `phone`                     | VARCHAR(32)   | nullable                 |
| `email`                     | VARCHAR(320)  | nullable                 |
| `status`                    | `user_status` | varsayılan `PENDING`     |
| `created_at` / `updated_at` | TIMESTAMPTZ   | `updated_at` trigger ile |
| `last_login_at`             | TIMESTAMPTZ   | nullable                 |

**Invariant'lar**

| Ad                      | Kural                                           | Neden                                                                                                                                                         |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users_contact_present` | `phone IS NOT NULL OR email IS NOT NULL`        | İletişim kanalı olmayan kayıt hiçbir akışta anlamlı değil                                                                                                     |
| `users_phone_e164`      | `phone ~ '^\+[1-9][0-9]{7,14}$'`                | Normalize edilmemiş numara (`0555…`, `+90 555…`, `905551…`) aynı kişi için birden fazla hesap demektir — ADR-0004'ün kapatmayı amaçladığı mükerrer hesap yolu |
| `uq_users_email`        | `UNIQUE (lower(email)) WHERE email IS NOT NULL` | `Ali@x.com` = `ali@x.com`; NULL'lar tekilliğe dahil değil                                                                                                     |
| `uq_users_phone`        | `UNIQUE (phone) WHERE phone IS NOT NULL`        | Aynı telefon iki hesapta olamaz                                                                                                                               |

Tekillik **`DELETED` kullanıcıları da kapsar**: silinmiş hesabın e-postası/telefonu serbest
bırakılırsa aynı iletişim bilgisiyle geçmişten kopuk ikinci bir kimlik açılabilir. Hesap silme
akışı (Faz 12 retention) iletişim alanlarını anonimleştirir; index'e `DELETED` istisnası eklenmez.

| Ad                     | Kural                 | Neden                                                                                      |
| ---------------------- | --------------------- | ------------------------------------------------------------------------------------------ |
| `users_set_updated_at` | BEFORE UPDATE trigger | `updated_at` uygulama koduna bırakılmaz; tek bir UPDATE yolunu unutmak audit hatası üretir |

### `user_roles`

| Kolon        | Tip                   | Not                 |
| ------------ | --------------------- | ------------------- |
| `user_id`    | UUID FK → `users(id)` | `ON DELETE CASCADE` |
| `role`       | `app_role`            |                     |
| `created_at` | TIMESTAMPTZ           |                     |

PK `(user_id, role)`: aynı rol iki kez verilemez, aynı kullanıcı birden fazla role sahip olabilir
(müşteri + sağlayıcı aynı hesapta — ADR-0004).

## Faz 2 tabloları

### `audit_logs` — değişmez denetim kaydı (ADR-0013)

| Invariant                 | Nasıl                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Append-only               | `BEFORE UPDATE OR DELETE` ve `BEFORE TRUNCATE` trigger'ları işlemi reddeder (role bağlı değil)                                                                |
| Tamper-evident            | `prev_hash`/`hash` zinciri veritabanında hesaplanır; `audit_chain_broken_at()` ilk bozuk satırı döner                                                         |
| Eşzamanlılık              | zincir hesaplaması `pg_advisory_xact_lock` ile serileştirilir (çatallanma olmaz)                                                                              |
| Kullanıcı silinebilirliği | `actor_user_id` üzerinde **FK yok**: audit değişmez olduğu için CASCADE/SET NULL uygulanamaz; FK olsaydı denetlenmiş kullanıcı hiç silinemezdi (KVKK, Faz 12) |
| Hassas veri               | `old_value`/`new_value` yalnızca "hangi alan değişti" bilgisini taşır, değerleri taşımaz                                                                      |

### `outbox`, `processed_events`, `idempotency_keys` (ADR-0010, ADR-0003)

| Tablo              | Amaç                                                    | Kritik nokta                                                                                                          |
| ------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `outbox`           | domain değişikliğiyle aynı transaction'da yazılan event | `status <> 'PUBLISHED'` kısmi indeksi; `CHECK ((status='PUBLISHED') = (published_at IS NOT NULL))` tutarlılığı zorlar |
| `processed_events` | tüketici bazlı idempotency                              | PK `(consumer, event_id)`: aynı event farklı tüketicilerde bir kez işlenir                                            |
| `idempotency_keys` | komut idempotency'si                                    | PK `(scope, key)`; `request_fingerprint` aynı anahtarın farklı gövdeyle kullanımını yakalar; Redis'te tutulmaz        |

### `auth_subjects`

Oturum kimliği (Firebase `sub`) ↔ `users.id` eşlemesi. Faz 3'te gelecek `identity_records`'dan
**ayrıdır**: bu tablo oturum kimliğiyle, o tablo doğrulanmış gerçek kimlikle ilgilidir.
PK `(provider, provider_subject)` aynı subject'in iki kullanıcıya bağlanmasını,
`UNIQUE (user_id, provider)` bir kullanıcının aynı sağlayıcıda iki subject'i olmasını engeller.

### Profiller ve katalog

| Tablo                                      | Kritik invariant'lar                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `customer_profiles`                        | `display_name` boş olamaz (`btrim` kontrolü)                                                                                                |
| `provider_profiles`                        | `state` enum (`DRAFT`→`APPROVED`…); `rating_avg` 1-5 arası; `(rating_avg IS NULL) = (rating_count = 0)` — ortalama ve sayaç birbirini tutar |
| `service_categories`, `services`, `skills` | `slug` regex ile kısıtlı ve UNIQUE; `services.default_duration_minutes` 1-1440                                                              |
| `provider_skills`                          | PK `(provider_id, skill_id)`; `verified` varsayılan `FALSE` — doğrulama Faz 3'e ait                                                         |

Katalog içeriği migration'a gömülmez; `npm run seed:catalog --workspace=@emek/api` ile yazılır
(idempotent). Testler de aynı seed fonksiyonunu kullanır.

## Faz 3 tabloları — kimlik

### `identity_records` — doğrulanmış gerçek kimlik (ADR-0004)

`auth_subjects` **oturum kimliğini** (Firebase `sub`), bu tablo **doğrulanmış gerçek kimliği**
tutar. İkisi ayrı domainlerdir: kullanıcı kimliğini doğrulamadan da oturum açabilir.

| Invariant                                                   | Nasıl                                                                                | Neden                                                                                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uq_identity_records_hash`                                  | `UNIQUE (identity_hash) WHERE identity_hash IS NOT NULL` — **sağlayıcıdan bağımsız** | Birincil tekillik. `(provider, provider_subject_id)` tek başına yetmez: aynı kişi A sağlayıcısıyla doğrulanıp sonra B ile doğrulanırsa çakışma üretmez (R-25) |
| `UNIQUE (verification_provider, provider_subject_id)`       | aynı sağlayıcı subject'i iki kullanıcıya bağlanamaz                                  | hesap devralma engeli                                                                                                                                         |
| `UNIQUE (user_id)`                                          | bir kullanıcının tek kimlik kaydı                                                    | "1 insan = 1 User"                                                                                                                                            |
| `CHECK (status <> 'VERIFIED' OR identity_hash IS NOT NULL)` | doğrulanmış kayıt hash taşımak zorunda                                               | tekillik kontrolü hash'e dayanır; hash'siz "doğrulanmış" kayıt kontrolü delerdi                                                                               |
| `CHECK ((status = 'VERIFIED') = (verified_at IS NOT NULL))` | durum ve zaman damgası tutarlı                                                       |                                                                                                                                                               |

**Saklanmayanlar:** ham T.C. kimlik numarası, isim, doğum tarihi, belge görüntüsü. Bunlar
yalnızca adapter içinde görülür, HMAC'e çevrilir ve atılır (ADR-0005).
`hash_key_version` teşhis içindir — rotasyon bir seçenek değildir (ADR-0004 §5).

### `verification_attempts`

| Invariant         | Nasıl                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| Replay koruması   | `UNIQUE (provider, external_session_id)` + servis katmanında `PENDING` dışı oturumun yeniden işlenmemesi |
| Durum tutarlılığı | `CHECK ((status = 'PENDING') = (completed_at IS NULL))`                                                  |
| Süre              | `CHECK (expires_at > created_at)`; süresi dolan oturum `EXPIRED` olur                                    |

Sonuç kodu sınıflandırılmıştır; sağlayıcının ham hata metni saklanmaz.

### `auth_subjects` yaşam döngüsü (Faz 3 güncellemesi)

Faz 2'deki `UNIQUE (user_id, provider)` kısıtı hesap kurtarmayı imkânsız kılıyordu: kurtarma,
kullanıcıya aynı sağlayıcıdan **yeni** bir oturum kimliği bağlamak demektir. Kısıt kaldırıldı,
yerine:

- `uq_auth_subjects_active_per_provider`: sağlayıcı başına en fazla **bir AKTİF** kimlik.
- `status` + `revoked_at` (+ tutarlılık CHECK'i): kurtarmada eski kimlik `REVOKED` olur.

Eski kimliği aktif bırakmak güvenlik açığıdır: telefon numaraları operatörlerce yeniden
tahsis edilir ve numarayı sonradan alan biri hesaba girebilirdi. Kimlik doğrulama yalnızca
`ACTIVE` kayıtları kabul eder.

### `users_contact_present` gevşetmesi

Kısıt artık `status = 'DELETED' OR phone IS NOT NULL OR email IS NOT NULL`. Invariant aktif
hesaplar için korunur; kurtarma sonrası kapatılan kabuk hesap iletişim bilgilerini serbest
bırakabilir (kullanıcı bunları kanonik hesabında kullanabilmeli).

## Faz 4 tabloları — konum, müsaitlik ve rezervasyon

### Coğrafi veri (PostGIS)

| Tablo                    | Kritik nokta                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addresses`              | `location` **türetilmiş** kolondur (`ST_MakePoint(longitude, latitude)`): lat/lon ile geometri ayrı yazılırsa zamanla ayrışır ve "haritada başka, sorguda başka" hatası sessizce oluşur. GIST indeksli; `EXPLAIN` testi indeksin kullanıldığını doğruluyor. Adres **silinmez, arşivlenir** — geçmiş rezervasyonlar referans verir |
| `provider_service_areas` | `MULTIPOLYGON`: sağlayıcı birbirine değmeyen bölgelerde çalışabilir. `CHECK (ST_IsValid(...))` — geçersiz geometri sorguları sessizce yanlış sonuç verdirir                                                                                                                                                                       |

### Müsaitlik

`availability` üzerinde `EXCLUDE USING GIST (provider_id WITH =, slot WITH &&)`: üst üste binen
iki pencere "hangisi geçerli" belirsizliği üretirdi. `availability_exceptions` **binebilir**
(iki farklı nedenle aynı gün kapatılabilir), bu yüzden orada EXCLUDE yok.

Tekrarlayan kural (RRULE) motoru **bilinçli olarak yok**: matching (Faz 7) gerçek ihtiyacı
netleştirmeden tekrarlama motoru yazmak kullanılmayan karmaşıklık olurdu. Genişletme gerekirse
uygulama katmanında yapılır, tablo değişmez.

### Rezervasyon

| Invariant                          | Nasıl                                                                                                             | Neden                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `bookings_no_overlap`              | `EXCLUDE USING GIST (provider_id WITH =, slot WITH &&) WHERE (status <> 'CANCELLED' AND provider_id IS NOT NULL)` | Çakışmanın tek doğruluk kaynağı. Predikat olmasa iptal edilen randevu slotu kalıcı bloklardı (T-05b) |
| `bookings_not_self`                | `customer_id <> provider_id`                                                                                      | Tek User/iki profil modeli kendi kendine rezervasyona izin verirdi (GMV/review manipülasyonu)        |
| `bookings_provider_required`       | `status = 'REQUESTED' OR provider_id IS NOT NULL`                                                                 | R-14 kararı: talep anında sağlayıcı yok, sonrasında zorunlu                                          |
| `bookings_cancellation_consistent` | `(status = 'CANCELLED') = (cancelled_at IS NOT NULL)`                                                             | Durum ve zaman damgası ayrışamaz                                                                     |
| `slot`                             | `tstzrange(start, end, '[)')` türetilmiş                                                                          | Bitişik randevular (biri bitince diğeri başlar) çakışma saymaz                                       |
| Para                               | `price_minor BIGINT` + `CHECK >= 0`                                                                               | Float ile para hesabı yasak; API'de string olarak taşınır                                            |

`booking_status_history` append-only trigger ile korunur (ADR-0006 §4). İlk kayıt booking
oluşturulurken yazılır; `CHECK (from_status IS NOT NULL OR to_status = 'REQUESTED')`.

`btree_gist` extension'ı gerekir: PostgreSQL'in varsayılan GIST operatör sınıfları UUID
eşitliğini desteklemez ve `provider_id WITH =` bu olmadan çalışmaz.

### Hizmet fiyatlandırması (Faz 4 review düzeltmesi)

Fiyat **istemciden alınmaz**: rezervasyon fiyatı katalogdan sunucuda hesaplanır. Aksi halde
müşteri (veya anlaşmalı müşteri-sağlayıcı çifti) keyfî düşük bir tutar kaydedip komisyon ve
GMV metriklerini manipüle edebilirdi.

| Invariant                        | Kural                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `services_pricing_consistent`    | `base_price_minor` yalnızca `FIXED`, `hourly_rate_minor` yalnızca `HOURLY` modelinde dolu olabilir                                          |
| `services_active_requires_price` | `NOT active OR (modeline uygun fiyat dolu)` — fiyatsız hizmet var olabilir (taslak) ama **aktif olamaz**; aktif hizmet rezervasyona açıktır |
| `services_price_non_negative`    | Negatif fiyat yok                                                                                                                           |

Tek parçalı bir CHECK, mevcut fiyatsız satırlar nedeniyle migration'ı kırardı; bu yüzden
invariant iki parçaya ayrıldı ve fiyatsız satırlar migration'da pasife alındı.

### `booking_requests` — NLP izlenebilirliği (Faz 6'da dolduruldu)

Tablo Faz 4'te oluşturuldu, Faz 6'da **kullanılmaya başlandı**. Ar-Ge kolonları
(`raw_text`, `structured_request`, `parser_version`, `parser_confidence`) opsiyonel
değildir, birlikte anlamlıdır (ADR-0012 §1):

| Durum                                                | `raw_text` | `structured_request` + `parser_version` |
| ---------------------------------------------------- | ---------- | --------------------------------------- |
| Serbest metin yolu                                   | dolu       | dolu                                    |
| Form yolu (AI erişilemez veya kullanıcı formu seçti) | boş        | boş                                     |

`CHECK ((structured_request IS NULL) = (parser_version IS NULL))` bu ikisinin
ayrışmasını engeller: sürümsüz bir yapılandırılmış çıktı, hangi parser'ın ürettiği
bilinmediği için deney karşılaştırmasında kullanılamazdı.

Ham metin **audit'e yazılmaz** (kişisel veri içerebilir); audit yalnızca hizmet,
süre, parser sürümü ve kaynağı (`TEXT`/`FORM`) kaydeder.

## Faz 5 tabloları — ödeme, uyuşmazlık, dijital ispat

### `payments` — ödemenin durumu (ADR-0009, ADR-0017)

Emek para tutmaz: burada yalnızca sağlayıcıdaki ödemenin **referansı ve durumu** izlenir.
Kart verisi (PAN, CVV, son kullanma) hiçbir kolonda yoktur ve test bunu şema seviyesinde
doğrular.

| Invariant                               | Kural                                                                                                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uq_payments_live_per_booking`          | Rezervasyon başına **en fazla bir canlı ödeme** (kısmi index: `FAILED`/`AUTHORIZATION_EXPIRED`/`REFUNDED` hariç). Düz UNIQUE, ilk başarısız denemeden sonra rezervasyonu kalıcı olarak ödenemez yapardı |
| `payments_authorization_complete`       | Yetkilendirilmiş durumlarda `authorized_at` **ve** `authorization_expires_at` dolu olmak zorunda; biri eksikse süre kontrolü sessizce atlanırdı                                                         |
| `payments_released_consistent`          | `status = 'RELEASED'` ⇔ `released_at` dolu                                                                                                                                                              |
| `refunded_minor <= amount_minor`        | Tutardan fazla iade edilemez                                                                                                                                                                            |
| `payments_failure_code_only_on_failure` | Hata kodu yalnızca başarısız/süresi dolmuş ödemede taşınır                                                                                                                                              |
| `payments_frozen_knows_origin`          | `DISPUTED` bir ödeme **nereye döneceğini bilmek zorunda** (`frozen_from_status`): bilinmezse çözüm sonrası para kilitlenirdi (review bulgusu C2)                                                        |
| `payments_freeze_origin_consistent`     | `frozen_from_status` yalnızca `DISPUTED` durumunda dolu olabilir                                                                                                                                        |

### `payment_events` — gelen webhook'lar

`UNIQUE (provider, external_event_id)` gelen olayı tekilleştirir (T-09). Tablo
**append-only**'dir: trigger DELETE'i ve kimlik alanlarının değiştirilmesini reddeder;
uygulanmış bir olay geri alınamaz. Ham gövde değil, sınıflandırılmış özet saklanır.

### `payment_commands` — giden çağrılar

`external_event_id` yalnızca **geleni** tekilleştirir; çift `authorize` göndermeyi
engellemez (ADR-0009 §5). Her giden çağrı gönderilmeden **önce** burada rezerve edilir:

| Invariant                                | Kural                                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `payment_commands_unique_key`            | Aynı idempotency anahtarıyla ikinci çağrı gönderilemez (T-38)                                        |
| `payment_commands_unique_attempt`        | `(payment_id, operation, attempt)` tekildir                                                          |
| `payment_commands_completion_consistent` | `status = 'PENDING'` ⇔ `completed_at` boş; "tamamlanmış ama PENDING" bir satır mutabakatı yanıltırdı |

### `disputes`

`uq_disputes_open_per_booking` kısmi unique index'i, aynı rezervasyon için **aynı anda**
yalnızca bir açık uyuşmazlığa izin verir: ikinci açık kayıt, release'in hangi gerekçeyle
bloklandığını belirsizleştirirdi. Kapanmış uyuşmazlıklar sınırsızdır.
`disputes_resolution_complete`, karara bağlanmış bir uyuşmazlığın kim ve ne zaman karar
verdiği bilgisini zorunlu kılar.

### `documents` — dijital ispat

Dosya Cloud Storage'da; burada yalnızca metadata + `sha256` + `storage_key` + zaman durur.
`documents_integrity_guard` trigger'ı `sha256`, `storage_key` ve `booking_id` alanlarının
yazıldıktan sonra değiştirilmesini reddeder: aksi halde önce/sonra fotoğrafı sessizce
başka bir nesneyle değiştirilebilir ve kanıt değerini kaybederdi.
`documents_available_has_hash`, hash'siz bir dokümanın `AVAILABLE` olmasını engeller.

### `reviews`

Değerlendirme matching skorunun girdisidir (Faz 7); manipüle edilebilir bir review tablosu
doğrudan algoritmayı manipüle eder. `reviews_one_per_author` (booking başına bir yazar bir
kez), `reviews_not_self` (kendine puan yok) ve `rating BETWEEN 1 AND 5` veritabanındadır.
"Yalnızca tamamlanmış rezervasyon" kuralı serviste uygulanır: CHECK içinden başka tabloya
bakılamaz.

## Faz 7 tabloları — eşleştirme ve karar kaydı

`provider_services` (PK `provider_id, service_id`) sağlayıcının **sattığı** hizmetleri
tutar. Yetkinlik (`provider_skills`) ile karıştırılmamalı: yetkinlik "ne yapabiliyor",
hizmet "neyi satıyor" sorusunun cevabıdır. Aday havuzu hizmetten başlar; `service_id`
üzerindeki kısmi indeks (`WHERE active`) bu erişim yolunu taşır.

`provider_profiles.max_daily_bookings` (SMALLINT, 1-10, varsayılan 2) optimizasyonun
kapasite kısıtıdır. `NULL` (sınırsız) bilinçli olarak seçilmedi: sınırsız kapasite,
çözücünün aynı sağlayıcıya sınırsız iş yığmasına izin verir ve kombinatoryal patlamaya
kapı açardı (R-16).

`provider_service_areas.radius_meters` (500-100.000) eklendi: bölgeler API'den
**merkez + yarıçap** olarak alınır ve yarıçap poligondan geri hesaplanmak yerine
saklanır — türetme, kullanıcının girdiği değeri yaklaşık geri verir ve düzenleme
akışında sapma birikirdi.

`matching_runs` bir eşleştirme çalıştırmasıdır. Üç sürüm kolonu (`algorithm_version`,
`weights_version`, `objective_version`) **zorunludur** (ADR-0012 §1): sürümsüz bir
karar geriye dönük karşılaştırılamaz. Ölçüm kolonları (`candidate_count`,
`eligible_count`, `constraint_violations`, `retrieval_ms`, `decision_ms`,
`optimization_runtime_ms`) üretimde de izlenebilmek içindir; yoksa laboratuvar sonucu
ile gerçek davranış ayrışır. `strategy <> 'RANKED_FALLBACK' OR degraded_reason IS NOT NULL`
CHECK'i, işaretsiz bir bozulmayı engeller.

`booking_match_results` her değerlendirilen adayı sırasıyla tutar. Skor bileşenleri
**ayrı kolonlardır** ve NUMERIC'tir (float değil): skorlar karşılaştırılan ve
raporlanan değerlerdir; ikili kayan nokta gösterimi aynı girdinin iki ortamda farklı
saklanmasına yol açardı. Her bileşen `BETWEEN 0 AND 1` ile sınırlıdır.

Invariant'lar:

- `UNIQUE (run_id, provider_id)` ve `UNIQUE (run_id, rank)` — bir sıra bir adaya aittir.
- Kısmi unique index `(run_id) WHERE selected` — bir çalıştırmada **en fazla bir** aday
  seçilir; iki seçili satır "hangi sağlayıcı atandı" sorusuna iki cevap verirdi.
- `NOT selected OR proposed_start IS NOT NULL` — seçim, "kim" ve "ne zaman"ın birlikte
  kararıdır; takvimsiz bir seçim eksik bir karardır.
- Tablo **append-only**'dir (trigger): karar değişirse yeni bir çalıştırma yazılır.
  Sonradan düzeltilebilen bir deney kaydı kanıt değeri taşımaz.

## Faz 8 tabloları — safety (ADR-0008, ADR-0019)

Tasarım: [safety.md](../architecture/safety.md).

### `safety_sessions` — rezervasyona bağlı güvenlik oturumu

- `booking_id` + denormalize `provider_id`/`customer_id` (her telemetride join yok).
- Durum `safety_session_status`; **rezervasyon başına tek açık oturum**
  (`uq_safety_sessions_open_booking`, `WHERE status <> 'CLOSED'`). Açma
  `ON CONFLICT ... DO NOTHING` ile eşzamanlılığa dayanıklı.
- Trigger `safety_session_status_guard`: durum geri gitmez, `CLOSED` terminaldir ve kapalı
  oturumun telemetri sayaçları değişemez. Geçiş tablosunun tamamı uygulamadadır.
- Oturum politikası kopyalanır: `service_location` (geography), `geofence_radius_meters`,
  doğruluk sınırı, debounce, telemetri aralığı/sapma/yaş sınırları — karar yeniden
  üretilebilsin diye.
- Telemetri durumu: `last_sequence` (replay), `last_captured_at`, son konum/doğruluk/mesafe,
  sayaçlar (`telemetry_count`, `rejected_count`, `integrity_rejection_count`,
  `mock_location_count`), `consecutive_speed_rejections`.
- Geofence: kabul edilmiş durum + başlangıcı, debounce adayı, `activation_geofence_state`.
- Değerlendirme: `next_evaluation_at` (izleyici; kısmi index yalnızca telemetri kabul eden
  oturumlar), `active_rules`, `anomaly_flagged`.
- Panik: `panic_raised_at`, `panic_count`, `emergency_resolved_at` (CHECK'lerle tutarlı).
- Retention: `retention_expires_at`, `location_purged_at` (CHECK: temizlenmiş oturumda son
  konum yok).

### `location_events` — ham telemetri (partition'lı)

- `PARTITION BY RANGE (server_received_at)` — anahtar **sunucu zamanı**; aylık partition +
  `DEFAULT` (partition unutulursa veri kaybolmaz). `safety_ensure_location_partition()`.
- `captured_at` (istemci) + `server_received_at` (sunucu); `location` generated geography +
  GIST; `distance_to_service_meters` ve tek örnek `geofence_state` ingest'te hesaplanır.
- Sıra numarası tekilliği unique index ile **garanti edilemez** (partition anahtarı
  gerektirir); garanti oturum satırı kilidi + `last_sequence` koşulu.
- `ON DELETE CASCADE` → oturum; retention satır silmedir.

### `safety_events` — append-only güvenlik olayları

- Tip, kaynak (`RULE`/`ML`/`USER`/`SYSTEM`/`OPERATOR`), seviye, `rule_id`+`rule_version`,
  `model_version`+`anomaly_score`, `actor_user_id` (**FK'siz**: append-only tabloda
  `SET NULL` bir UPDATE'tir), `details` (koordinat içermez).
- `seq` identity: aynı transaction'daki olayların sırası. `occurred_at` = `clock_timestamp()`.
- CHECK: kural olayı kural kimliği, ML olayı model sürümü, kullanıcı/operatör olayı aktör taşır.
- `uq_safety_events_panic (session_id, details->>'panicNumber')` + panik olayında
  `panicNumber` zorunlu.
- Trigger + REVOKE: UPDATE/DELETE/TRUNCATE yok.

### `safety_risk_assessments` — her değerlendirme (append-only)

Uygulanan ve hesaplanan seviye, önceki seviye, belirleyen kaynak, kural seti + toplama
sürümü, tetiklenen kurallar (kanıtla), model sürümü/skoru/kalitesi/katkıları, model
erişilemezse nedeni (CHECK: ya skor ya neden), rota kaynağı, eksik sinyaller, normalize
sinyaller (koordinatsız), gecikme. Yalnızca alarm üretenler değil **her** değerlendirme
saklanır: yanlış alarm oranının paydası budur.

## Sonraki fazlarda gelecek yapılar

Bunlar Faz 1'de **bilinçli olarak yok**; ilgili domain ile birlikte gelir:

| Faz | Yapı                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3   | `identity_records` (sağlayıcıdan bağımsız `identity_hash` unique index), `verification_attempts`                                                              |
| 4   | `addresses`, `provider_service_areas` (MULTIPOLYGON + GIST), `availability`, `bookings` (+ `EXCLUDE USING GIST` iptal predikatıyla), `booking_status_history` |
| 5   | `payments`, `payment_events`, `documents`, `disputes`, `reviews`                                                                                              |
| 8   | ✅ `safety_sessions`, `location_events` (partition + retention), `safety_events`, `safety_risk_assessments`                                                   |

## Migration kuralları

- Elle DDL çalıştırılmaz; şema yalnızca migration ile değişir.
- Her migration `down` yönünü uygular; geri alınamayan veri dönüşümleri ayrı adıma alınır.
- Invariant'lar uygulamada **ve** veritabanında zorlanır: uygulama ilk, DB son savunmadır.
- Migration içeriği integration testleriyle doğrulanır (`services/api/test/migrations.integration.spec.ts`).
