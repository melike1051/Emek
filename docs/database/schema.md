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

| Migration                           | İçerik                                                         |
| ----------------------------------- | -------------------------------------------------------------- |
| `…120000_shared-updated-at-trigger` | Paylaşılan `set_updated_at()` fonksiyonu                       |
| `…120100_init-extensions-and-users` | Extension'lar, `user_status`/`app_role`, `users`, `user_roles` |

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

## Sonraki fazlarda gelecek yapılar

Bunlar Faz 1'de **bilinçli olarak yok**; ilgili domain ile birlikte gelir:

| Faz | Yapı                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2   | `audit_logs` (append-only + hash zinciri), `outbox`, `processed_events`, `idempotency_keys`, profiller, hizmet katalogu                                       |
| 3   | `identity_records` (sağlayıcıdan bağımsız `identity_hash` unique index), `verification_attempts`                                                              |
| 4   | `addresses`, `provider_service_areas` (MULTIPOLYGON + GIST), `availability`, `bookings` (+ `EXCLUDE USING GIST` iptal predikatıyla), `booking_status_history` |
| 5   | `payments`, `payment_events`, `documents`, `disputes`, `reviews`                                                                                              |
| 7   | `booking_match_results` (Ar-Ge skor bileşenleri + `algorithm_version`)                                                                                        |
| 8   | `safety_sessions`, `location_events` (partition + retention), `safety_events`                                                                                 |

## Migration kuralları

- Elle DDL çalıştırılmaz; şema yalnızca migration ile değişir.
- Her migration `down` yönünü uygular; geri alınamayan veri dönüşümleri ayrı adıma alınır.
- Invariant'lar uygulamada **ve** veritabanında zorlanır: uygulama ilk, DB son savunmadır.
- Migration içeriği integration testleriyle doğrulanır (`services/api/test/migrations.integration.spec.ts`).
