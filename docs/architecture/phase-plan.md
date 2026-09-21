# Faz Planı

Her faz: `inspect → plan → implement (test ile) → integrate → code review → security review →
performance review → docs → git diff review → PHASE COMPLETE`.
Faz tamamlanınca otomatik olarak sonrakine geçilmez.

**Genel exit kriterleri (her faz için geçerli):**

- Fazın tüm testleri yeşil; yeni kod için test yazılmış (testsiz feature tamamlanmış sayılmaz).
- Faz sonu tam code review yapıldı; bulunan sorunlar aynı faz içinde kapatıldı.
- Migration'lar ileri ve geri çalışıyor.
- İlgili dokümanlar güncellendi; yeni mimari karar varsa ADR yazıldı.
- `git status` temiz veya bilinçli olarak commit'lendi; secret sızıntısı yok.
- Kalan riskler ve varsayımlar `docs/research/technical-risks.md`'de güncel.

---

## Faz 0 — Repository & Architecture Audit ✅

**Çıktılar:** blueprint analizi, repo denetimi, monorepo iskeleti, `CLAUDE.md`, 12 ADR,
konvansiyonlar, event kataloğu, test stratejisi, veri koruma baseline'ı, teknik riskler,
Ar-Ge metrikleri, bu faz planı.

**Exit:** uygulama kodu yazılmadı; tüm bağlayıcı kararlar yazılı ve gerekçeli.

---

## Faz 1 — Foundation ✅

**Kapsam:** npm workspaces monorepo + uv Python toolchain; NestJS skeleton (config, logging,
validation, error filter, health); FastAPI skeleton (health, settings, schema validation);
PostgreSQL 16 + PostGIS ve Redis için Docker Compose; migration altyapısı + ilk migration
(extensions, enum'lar, `users`, `user_roles`); environment/config şeması (zod/pydantic ile
doğrulanan, eksik değişkende **boot'ta fail**); temel CI (lint → typecheck → unit → build).

**Exit kriterleri (durum):**

- ✅ `npm run infra:up` ile Postgres+PostGIS + Redis ayağa kalkıyor. Pub/Sub emulator opsiyonel
  profile'a alındı (`npm run infra:up:events`): imaj ~1.5GB ve Faz 1'de hiçbir kod Pub/Sub
  kullanmıyor — outbox ile Faz 2'de devreye girer.
- ✅ `GET /api/v1/health` Postgres, PostGIS ve Redis durumunu ayrı ayrı raporluyor; bağımlılık
  düştüğünde 503 + `checks` gövdesi. `GET /api/v1/health/live` bağımlılık kontrolü yapmaz
  (geçici DB arızasında container yeniden başlatılmamalı).
- ⚠️ **Kapsam düzeltmesi:** AI servisi `/health` DB/Redis raporlamıyor. Faz 1'de AI servisi
  veritabanı kullanmıyor; yalnızca health check için `asyncpg` eklemek "tüketicisi olmayan
  dependency" olurdu. AI readiness yapılandırma + `parser_version` raporlar; DB kontrolü
  Faz 6-7'de candidate retrieval ile birlikte eklenecek.
- ✅ İlk migration `up`/`down` yönünde çalışıyor; PostGIS extension ve enum sırası testle doğrulandı.
- ✅ Config şeması eksik/hatalı env ile servisi başlatmıyor; mock sağlayıcı + production
  kombinasyonu reddediliyor (ADR-0005/0009 kuralı config katmanında test edildi).
- ✅ CI workflow'u lint → format → typecheck → unit → migration up/down/up → integration → build
  (+ AI servisi için ruff/mypy/pytest + container build) adımlarını içeriyor. `.env` `.gitignore`'da.
- ✅ Python 3.12'ye pinlendi (`.python-version`, Dockerfile, CI); yerel 3.9 kullanılmıyor.
- ✅ `npm audit`: 0 açık (multer DoS açığı `overrides` ile kapatıldı — ADR-0015).

**Bu fazda alınan ek kararlar:** ADR-0014 (ham SQL migration), ADR-0015 (NestJS 11/CJS,
TypeScript 6, uv, sürüm pinleme).

**Faz 1 code review bulguları ve çözümleri** (bağımsız review agent'ı; blueprint, ADR'ler ve
test stratejisini sıfırdan okuyarak). Hepsi aynı faz içinde kapatıldı:

| Bulgu                                                                                                                 | Çözüm                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lazyConnect` + `enableOfflineQueue: false` ilk Redis komutunu her zaman reddediyor → health boot'tan sonra 503 döner | `enableOfflineQueue: true` + `commandTimeout`/`maxRetriesPerRequest` sınırları; `lazyConnect` kaldırıldı. Regresyon testi: `health-dependencies.integration.spec.ts` |
| Integration testleri geliştirme veritabanını sıfırlıyor, veri temizliği yok                                           | Ayrı `emek_test` veritabanı + `_test` son eki kontrolü (aksi halde koşucu başlamaz), `afterEach` TRUNCATE, `maxWorkers: 1` config'e taşındı                          |
| Bootstrap yapılandırması testlerde kopyalanmış → üretimdeki davranış test edilmiyor                                   | `configureApp()` ayrıştırıldı; main ve integration testleri aynı kurulumu kullanıyor                                                                                 |
| `listen()` başarısız olursa açık pool/Redis ile süreç ayakta kalıyor                                                  | `app.close()` + `process.exit(1)`                                                                                                                                    |
| Global filter HTTP dışı bağlamda (Faz 9 Pub/Sub) Express response arayacak                                            | `host.getType() !== 'http'` guard'ı + test                                                                                                                           |
| `BusinessException` sabit mesaj politikasını atlayabiliyor                                                            | Mesaj varsayılan olarak `CLIENT_MESSAGES[code]`; özel metin açık `clientMessage` ile                                                                                 |
| pino `redact` joker karakteri tek seviye eşliyor → derin PII maskelenmiyor                                            | Anahtar adına göre derin maskeleme (`redact.ts`) + iç içe/`err` testleri                                                                                             |
| İstemci `x-request-id` göndererek audit korelasyonunu bulandırabiliyor                                                | `requestId` her zaman sunucuda üretilir; istemci değeri `clientTraceId` olarak yalnızca bilgi amaçlı taşınır                                                         |
| Telefon normalize edilmiyor → aynı kişi birden fazla hesap açabilir                                                   | `users_phone_e164` CHECK + 5 biçim için test                                                                                                                         |
| `DELETED` kullanıcı iletişim bilgisini serbest bırakıyor mu (tanımsız)                                                | Karar yazıldı ve test edildi: tekillik `DELETED`'ı da kapsar                                                                                                         |
| Paylaşılan `set_updated_at()` ilk tablonun migration'ında → sonraki rollback'leri kırar                               | Kendi migration'ına alındı + sabit `search_path`                                                                                                                     |
| Faz 3'e kadar kullanılmayan doğrulama enum'ları Faz 1'de oluşturuluyor                                                | Kaldırıldı; `identity_records` ile gelecek (test bunu doğruluyor)                                                                                                    |
| `.dockerignore` yok → host `node_modules` ve `.env` imaja giriyor                                                     | `.dockerignore` eklendi                                                                                                                                              |
| CI'da `permissions` bloğu yok                                                                                         | `permissions: contents: read`                                                                                                                                        |
| Health endpoint'i kimlik doğrulamasız ve her çağrı 3 bağlantı alıyor                                                  | 1 saniyelik önbellek + eşzamanlı çağrıların tek turu paylaşması (+ test)                                                                                             |
| Tautolojik testler (`latencyMs >= 0`, postgis mock'u postgres'ten ayrışmıyor)                                         | Silindi/yeniden yazıldı; PostGIS eksikliği ayrı ayırt edilebilir senaryo oldu                                                                                        |
| Aşırı mühendislik: 15 geçişli `AppConfigService`, tek dosya için `packages/config` workspace'i                        | Config doğrudan tiplenmiş `env` nesnesini sunar; `packages/config` kaldırıldı                                                                                        |

---

## Faz 2 — Core Backend ✅

**Kapsam:** Firebase Auth token doğrulama + session; `users`, `roles`, `user_roles`; RBAC guard'ları
(`CUSTOMER`/`PROVIDER`/`ADMIN`/`SUPPORT`) + ownership kontrolü + `docs/security/rbac-matrix.md`
(ADR-0013); `customer_profiles`, `provider_profiles`; `service_categories`, `services`, `skills`,
`provider_skills`; `packages/api-contracts` ilk OpenAPI sözleşmesi; merkezî hata yönetimi +
`docs/api/error-codes.md`; structured logging (request id, user id, PII maskeleme); rate limiting
temeli.

**Bu fazda kurulan ortak altyapı** (sonraki fazlar bunlara bağımlı, bu yüzden geriye bırakılamaz):

- `audit_logs` + **rol ayrımı** (uygulama rolüne UPDATE/DELETE yok) + hash zinciri (ADR-0013 §6-7).
- **Transactional outbox** tablosu + publisher + `processed_events` tablosu (ADR-0010 §2).
  Faz 3'ün `IdentityVerified`, Faz 5'in `PaymentAuthorized` ve Faz 8'in `SafetyAlertRaised`
  garantisi buna dayanır.
- `idempotency_keys` tablosu ve `Idempotency-Key` middleware'i (ADR-0003).

**Exit kriterleri (durum):**

- ✅ Auth/RBAC: token yok/geçersiz → 401, rol yok → 403, askıya alınmış hesap → 403 (T-30).
  Kullanıcı verisi yalnızca `/me` üzerinden; yol parametresiyle IDOR yüzeyi açılmadı.
- ✅ Guard'sız endpoint taraması (T-37): rota keşfi guard ile **aynı** metadata çözümlemesini
  kullanır ve beyaz liste iki yönlü doğrulanır (tespit bozulursa test kırılır).
- ✅ `audit_logs` UPDATE/DELETE/TRUNCATE reddediliyor + hash zinciri kopukluğu tespit ediliyor
  (T-35 kısmi — rol ayrımı Faz 13, T-36).
- ✅ Outbox: event domain değişikliğiyle aynı transaction'da yazılıyor, transport hatasında
  PENDING kalıp yeniden deneniyor, atomik sahiplenme çift yayını engelliyor (T-39).
- ✅ Idempotency: kalıcı kayıt (Redis flush'ı bozmuyor — T-07c), farklı gövde reddi (T-07b),
  eşzamanlı istek paralel yürütülmüyor, **kapsam kullanıcıyı içeriyor** (çapraz kullanıcı
  sızıntısı testi).
- ✅ OpenAPI sözleşmesi üretiliyor ve contract testi kod ile dosya ayrışmasını yakalıyor.
- ✅ Ham 500 mesajı sızmıyor (T-31); loglarda PII yok (T-32, derin maskeleme).
- ✅ 77 unit + 103 integration test; lint/typecheck/format/build temiz; `npm audit` 0 açık.

**Bu fazda alınan ek karar:** ADR-0016 (Firebase ID token doğrulaması `jose` + JWKS ile;
`firebase-admin` bağımlılığı reddedildi — 8 moderate açık ve kullanılmayan Firestore/Storage ağacı).

**Faz 2 code review bulguları ve çözümleri** (bağımsız review agent'ı):

| Bulgu                                                                                                                            | Çözüm                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Kritik:** idempotency kapsamı kullanıcıyı içermiyordu → başka kullanıcının saklanmış yanıtı aynı anahtar+gövdeyle okunabilirdi | Kapsam `metot + yol + kullanıcı`; çapraz kullanıcı sızıntısı testi eklendi                                        |
| `FOR UPDATE SKIP LOCKED` havuz üzerinden çalışan tek SELECT'te kilit tutmuyor → iki instance çift yayın yapar                    | Atomik sahiplenme: `UPDATE ... WHERE event_id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING` + kiralama süresi |
| `OUTBOX_MAX_ATTEMPTS` etkisiz: claim sorgusu `FAILED` kayıtları da alıyordu                                                      | Claim yalnızca `PENDING` okur; FAILED kayıt bir daha alınmaz                                                      |
| Audit hash zinciri eşzamanlılıkta çatallanıyor (`BIGSERIAL` id, trigger'dan önce atanır)                                         | Advisory lock trigger'dan çıkarılıp `AuditService.record()` içinde INSERT'ten önce alınıyor                       |
| Zincir payload'ı oturum saat dilimine bağlıydı → farklı TZ ile bağlanan doğrulama işi her satırı "bozuk" görürdü                 | `to_char(... AT TIME ZONE 'UTC', ...)` ve `host(ip)` ile deterministik biçim                                      |
| `complete()` fire-and-forget: yanıt kayıt yazılmadan gidiyordu; çökme sonrası anahtar 24 saat kilitli kalıyordu                  | Kayıt yanıttan önce yazılıyor; kiralama süresi dolan IN_PROGRESS rezervasyon devralınabiliyor                     |
| Rate limit'in kullanıcı dalı ölüydü (guard auth'tan önce çalışıyor)                                                              | Ölü dal kaldırıldı, IP bazlı olduğu belgelendi; kullanıcı bazlı kota Faz 12                                       |
| `UnitOfWork`: rollback başarısızsa bozuk bağlantı havuza dönüyordu                                                               | `client.release(error)` ile bağlantı yok ediliyor                                                                 |
| Eşzamanlı ilk oturum unique ihlaliyle 500 veriyordu                                                                              | `23505` yakalanıp mevcut kullanıcı okunuyor + eşzamanlılık testi                                                  |
| `auth_subjects` sorgusu `provider` filtrelemiyordu → ikinci sağlayıcı eklendiğinde kimlik karışması                              | Sorgu `provider`'ı da filtreliyor, sabit tek yerde                                                                |
| T-35 "rol ayrımı Faz 2'de kurulu" diyordu ama trigger tabanlı koruma vardı                                                       | Test stratejisi dürüstleştirildi (kısmi), `REVOKE ... FROM PUBLIC` eklendi, rol ayrımı Faz 13                     |
| Tamper testi geri yüklemeyi `try` içinde yapıyordu → assert düşerse zincir kalıcı bozulur                                        | Geri yükleme `finally`'ye taşındı                                                                                 |
| Oran sınırı testi "fail-closed" diyordu ama onu test etmiyordu                                                                   | Başlık düzeltildi; fail-closed guard'ın unit testinde                                                             |
| Route-coverage'da dolgu iddia (`protectedCount > n/2`)                                                                           | Kaldırıldı; testin metadata sınırı belgelendi                                                                     |
| `audit_logs` down migration'ı denetim izini sessizce siliyor                                                                     | Uyarı yorumu + ADR-0013 §8 retention-locked export referansı                                                      |

---

## Faz 3 — Identity ✅

**Kapsam:** `identity_records`, `verification_attempts` + constraint'ler (ADR-0004: `identity_hash`
üzerinde sağlayıcıdan bağımsız partial unique index dahil); `IdentityVerificationProvider` port +
`MockIdentityProvider`; verification session API (`POST /verification/session`,
`GET /verification/session/:id`, imzalı `POST /verification/callback`, `GET /verification/status`);
**adapter içinde** KMS HMAC ile `identity_hash` üretimi (`hash_key_version` teşhis amaçlı,
rotasyon kapalı); unique identity enforcement; account recovery akışı; verification level geçişleri;
audit.

**Exit kriterleri (durum):**

- ✅ Tekillik **sağlayıcıdan bağımsız** `identity_hash` üzerinde, veritabanında zorlanıyor;
  eşzamanlı doğrulama tek kimlik kaydı üretiyor (T-01), farklı sağlayıcıyla ikinci hesap
  açılamıyor (T-01b).
- ✅ Deterministik hash üretemeyen sağlayıcı doğrulanmış seviye veremiyor (T-01c, `capabilities()`).
- ✅ Recovery: kimlik eşleşmesi kurtarmayı **tamamlamaz**, inceleme talebi açar; oturum kimliğini
  taşımak operatör onayına bağlıdır (T-02). `HIGH` güvence zorunlu, hedef hesap başına tek
  bekleyen talep, kullanıcı bazlı deneme sayacı + IP oran sınırı, her adım audit'li. Kabuk
  hesabın kendi verisi varsa talep açılmıyor. Onayda eski oturum kimliği **iptal ediliyor**
  (geri dönüştürülen telefon numarası riski).
- ✅ Sağlayıcı erişilemezken hiçbir kayıt oluşmuyor; akış yeniden denenebilir (T-03).
- ✅ Mock sağlayıcı production config'inde reddediliyor (T-04, config testi).
- ✅ Ham kimlik verisi hiçbir sütunda, audit'te, event'te veya API yanıtında yok
  (veri minimizasyonu testi tüm tabloları tarıyor). `identity_hash` API yanıtlarında dönmüyor.
- ✅ Callback: imza adapter içinde doğrulanıyor, ham gövde üzerinden; imzasız/yanlış imzalı/
  gövdesi değiştirilmiş çağrılar reddediliyor, replay ikinci yan etki üretmiyor.
- ✅ 95 unit + 129 integration test; lint/typecheck/format/build temiz.

**Bu fazda alınan tasarım kararları (ADR güncellemeleri):**

- `auth_subjects` yaşam döngüsü: kurtarmada eski oturum kimliği `REVOKED` olur. Aktif bırakmak,
  operatörlerce yeniden tahsis edilen telefon numaraları nedeniyle hesap devralma yolu açardı.
- `users_contact_present` yalnızca aktif hesaplar için zorunlu: kapatılan kabuk hesap iletişim
  bilgilerini serbest bırakmalı.
- Reddetme sonuçları transaction'da **commit edilir**, hata sonra fırlatılır: aksi halde rollback
  reddetme audit'ini ve `verification_attempts` kaydını da silerdi.

**Faz 3 code review bulgusu (kritik) ve çözümü:**

Bağımsız güvenlik review'u, otomatik hesap kurtarmada bir **devralma yolu** buldu: saldırgan
kurtarma oturumunu kendi hesabından başlatır, bağlantıyı mağdura ulaştırır; mağdur kendi
belgesiyle gerçek ve yüksek güvenceli bir doğrulama yapar. Güvence seviyesi belgeyi sunanı
doğrular ama **oturumu başlatanı doğrulamaz** — sonuçta saldırganın oturum kimliği mağdurun
hesabına taşınırdı.

Çözüm: otomatik devir kaldırıldı. Kimlik eşleşmesi artık `account_recovery_requests` kaydı
açar; taşıma yalnızca operatör onayıyla (`approveRecovery`, Faz 10 admin endpoint'i) yapılır ve
onaylayan audit'e yazılır. Devralma senaryosu doğrudan test edildi.

Aynı review'da işaretlenen diğer noktalar: `markDeleted` tam silme değildir (Faz 12 retention —
R-38), KMS anahtarı bağlanana kadar production'da doğrulama akışı çalışamaz (bilinçli, R-39),
mock sağlayıcının test kancası yalnızca config guard'ıyla korunuyor (T-04).

---

## Faz 4 — Provider & Booking ✅

**Kapsam:** `addresses` + PostGIS `location`; `provider_service_areas` (MULTIPOLYGON + GIST);
`availability`, `availability_exceptions` (recurrence); `booking_requests`; `bookings` +
`booking_status_history`; merkezî state machine (ADR-0006); çakışma engeli
(`EXCLUDE USING GIST` — **iptal durumlarını dışlayan predikatla**; Redis lock gereksiz
çıktı, bkz. ADR-0006 uygulama notu);
DB invariant'ları (`customer_id <> provider_id`, zaman/fiyat CHECK'leri, duruma bağlı `provider_id`);
booking API'leri (create/confirm/cancel/check-in/check-out/complete).
**R-14 kararı bu fazda ADR ile kapanır** (`provider_id` nullable + duruma bağlı zorunluluk).

**Exit kriterleri (durum):**

- ✅ Geçersiz state geçişi reddediliyor ve geçmişe yazılmıyor (T-06); transition map 20+ birim
  testiyle korunuyor (adım atlama, geri dönüş, terminal durumdan çıkış, SUPPORT'un hiçbir
  geçişi tetikleyememesi, erişilemeyen durum olmaması).
- ✅ Eşzamanlı 4 istek tek rezervasyon üretiyor, diğerleri kodlu 409 alıyor (T-05).
- ✅ İptal edilen slot yeniden rezerve edilebiliyor (T-05b); bitişik aralıklar çakışma saymıyor.
- ✅ Kendi kendine rezervasyon hem serviste hem DB CHECK'inde reddediliyor (T-05c).
- ✅ Redis boşken doğruluk korunuyor (T-05e) — **çünkü lock hiç yok**: çakışmanın tek kaynağı
  EXCLUDE constraint'i (ADR-0006 uygulama notu).
- ✅ Aynı geçişin tekrarı yan etki üretmiyor (T-07); tarafı olmayan kullanıcı rezervasyonun
  varlığını bile göremiyor (404).
- ✅ PostGIS konumu lat/lon'dan türetiliyor ve coğrafi sorgu GIST indeksini kullanıyor
  (`EXPLAIN` testte doğrulandı).
- ✅ Tüm geçişler `booking_status_history`'de; tablo append-only.
- ✅ 110 unit + 161 integration test; lint/typecheck/format/build temiz.

**R-14 kapandı:** `provider_id` nullable + duruma bağlı CHECK (ADR-0006 uygulama notu).

**Faz 4 code review bulguları ve çözümleri** (bağımsız review agent'ı):

| Bulgu                                                                                                                | Çözüm                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fiyat tamamen istemciden geliyordu** → keyfî düşük tutarla komisyon/GMV manipülasyonu                              | `services` tablosuna fiyatlandırma eklendi; fiyat sunucuda hesaplanıyor, DTO'dan `priceMinor` kaldırıldı. Fiyatsız hizmet **aktif olamaz** (CHECK) |
| `ADMIN` sahiplik kapısından geçemiyordu → operatör geçişleri (Faz 8 güvenlik askısı, dispute) hiç tetiklenemezdi     | Admin taraf olmadan yükleyebiliyor; audit'li. Admin olmayan üçüncü kişi hâlâ 404                                                                   |
| `CHECKED_IN` sonrası güvenlik dışı aksaklıkta rezervasyon sıkışıyordu                                                | `CHECKED_IN`/`IN_PROGRESS`/`CHECKED_OUT` → `CANCELLED` operatöre açıldı; taraflar hâlâ iptal edemez                                                |
| Müsaitlik kontrolü transaction dışındaydı (TOCTOU): pencere aradan silinebilirdi                                     | Kontrol transaction içine alındı, pencere `FOR SHARE` ile kilitleniyor                                                                             |
| `bookings_not_self` dışındaki CHECK ihlalleri 500 üretiyordu; `scheduledEnd > scheduledStart` DTO'da doğrulanmıyordu | Servis seviyesinde zaman doğrulaması + genel CHECK → 400 çevirisi                                                                                  |
| T-05e testi adında "Redis erişilemez" diyordu ama flushdb yapıyordu ve zaten lock yoktu                              | Test adı ve ADR gerçeği yansıtacak şekilde düzeltildi                                                                                              |

Reviewer'ın doğruladıkları: EXCLUDE constraint tasarımı yarışa dayanıklı ve eşzamanlılık testi
tautolojik değil; `bookingIn()` gerçek geçiş yolunu kullanıyor; 404-yerine-403 tutarlı;
`FOR UPDATE` kapsamı doğru ve deadlock riski yok; RRULE'un yokluğu Faz 7'yi engellemiyor.

---

## Faz 5 — Payment & Digital Proof ✅

**Kapsam:** `PaymentProvider` port + mock/sandbox adapter (giden idempotency anahtarıyla);
`payments` (+ `authorization_expires_at`), `payment_events`, `payment_commands`; ödeme state
machine (booking aggregate root, payment projeksiyon — ADR-0009, ADR-0017); re-authorization
akışı; imzalı + idempotent webhook handler; `disputes`; `documents` + storage portu ve kısa
ömürlü signed URL; before/after kanıt akışı ve `sha256` bütünlük kaydı; `reviews` invariant'ları.

**Exit kriterleri (durum):**

- ✅ Duplicate webhook ikinci kez yan etki üretmiyor, yine 200 dönüyor (T-09); olay
  `UNIQUE (provider, external_event_id)` ile bir kez kaydediliyor.
- ✅ Out-of-order event reddediliyor, durum geriye çekilmiyor ve red audit'leniyor (T-10).
- ✅ Açık uyuşmazlık **ve** `SAFETY_HOLD` varken release bloklanıyor, gerekçe audit'e
  yazılıyor ve sağlayıcıya hiç çağrı gitmiyor (T-11).
- ✅ Yetkilendirme süresi dolmuşken release **denenmiyor**; re-authorization süreyi uzatıyor
  ve çift yetkilendirme oluşmuyor (T-34). Süresi dolan yetkilendirmeler zamanlanmış işle
  `AUTHORIZATION_EXPIRED` oluyor.
- ✅ Event'ten para hareketi tetiklenmiyor (T-38): webhook hiçbir giden komut üretmiyor;
  ikinci yetkilendirme denemesi `payment_commands` UNIQUE'inde duruyor.
- ✅ Storage nesneleri private; yalnızca kısa ömürlü imzalı URL ile erişilebiliyor; imzasız,
  kurcalanmış ve süresi dolmuş URL reddediliyor (T-12). Her erişim audit'li.
- ✅ Kart verisi hiçbir kolonda tutulmuyor — şema seviyesinde test ediliyor.
- ✅ Para serbest bırakılmadan rezervasyon `SETTLED` olamıyor; hizmet tamamlanınca para
  otomatik çıkmıyor (uyuşmazlık penceresi korunuyor).
- ✅ Uyuşmazlığı taraflar açıyor, yalnızca operatör karara bağlıyor; değerlendirme yalnızca
  tamamlanmış hizmette ve bir kez yazılabiliyor.
- ✅ 126 unit + 227 integration test; lint/typecheck/format/build temiz.

**`payments.booking_id UNIQUE` kararı verildi** (ADR-0017): düz UNIQUE yerine kısmi unique
index — rezervasyon başına bir **canlı** ödeme, ama başarısız deneme yeni denemeyi
engellemiyor. Ayrı `payment_intents` tablosu yazılmadı; gerekçe ADR-0017 §1.

**Faz 5 code review bulguları ve çözümleri** (bağımsız review agent'ı):

| Bulgu                                                                                                                                                                                                                                                                    | Önem     | Çözüm                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Belirsiz sağlayıcı hatasından sonra capture/refund retry'ı YENİ idempotency anahtarı üretiyordu** (`countCommands+1`). Sağlayıcıya ulaşmış ama yanıtı kaybolmuş bir çağrı ikinci kez gönderilirse para iki kez hareket ederdi                                          | CRITICAL | Retry **aynı komut satırını ve anahtarı** yeniden kullanıyor. Kiralama süresi (60 sn) dolmamış `PENDING` satır "hâlâ uçuşta" sayılıp reddediliyor; yeni anahtar yalnızca sağlayıcının **kesin** reddinden sonra üretiliyor. Belirsiz hatada komut `FAILED` değil `PENDING` bırakılıyor |
| **Ödeme bir kez `DISPUTED` olunca kalıcı kilitleniyordu:** `DISPUTED`'dan tek çıkış `REFUNDED`'dı. Sağlayıcı lehine karar verilmiş uyuşmazlıkta veya güvenlik yanlış alarmında, hizmeti tamamlamış sağlayıcının parası ne serbest bırakılabiliyor ne iade edilebiliyordu | CRITICAL | `payments.frozen_from_status` eklendi (migration + CHECK). Uyuşmazlık kararı ve `SAFETY_HOLD → IN_PROGRESS` geçişi ödemeyi **dondurulduğu duruma** döndürüyor; başka açık uyuşmazlık varsa çözülmüyor                                                                                  |
| Testler bu iki yolu hiç egzersiz etmiyordu; `setUnavailable(true)` hiçbir testte kullanılmıyordu. Bir test yorumunda "ödeme sonsuza kadar bloklu kalmaz" iddia ediliyor ama yalnızca booking durumuna bakılıyordu                                                        | HIGH     | 6 yeni test: capture/refund timeout + retry anahtarı, kesin red sonrası yeni anahtar, uyuşmazlık çözümü sonrası gerçek release, güvenlik yanlış alarmı sonrası tam akış, ikinci açık uyuşmazlıkta çözülmeme                                                                            |
| Yükleme boyut sınırı yalnızca mock'ta uygulanıyordu; gerçek GCS imzalı PUT'ta `x-max-bytes` başlığı bir şey uygulamaz — sınır sessizce buharlaşırdı                                                                                                                      | HIGH     | `confirmUpload` sunucu tarafında boyutu doğruluyor; mock'a sınır uygulamayan `forcePut` eklendi ki test gerçeği ölçsün. Bucket seviyesi politika R-41 olarak Faz 13'e bağlandı                                                                                                         |
| Guard ile capture arasında TOCTOU penceresi belgelenmemişti                                                                                                                                                                                                              | MEDIUM   | ADR-0017 §8'de kabul, gerekçe ve telafi yolu (iade) yazıldı; R-43 olarak risk kütüğüne eklendi                                                                                                                                                                                         |
| İade tutarı istemciden JS `number` olarak alınıyordu (sistemin geri kalanı BIGINT→string)                                                                                                                                                                                | MEDIUM   | `amountMinor`/`refundAmountMinor` string'e çevrildi, regex ile doğrulanıyor                                                                                                                                                                                                            |

Reviewer'ın doğruladıkları: webhook idempotency ve para hareketi ayrımı (webhook hiçbir
giden çağrı üretmiyor), AUTHORIZE akışının sabit anahtarı, şema invariant'larının DB'de
zorlanması, dispute/review yetkilendirmesi ve veri ifşası (yazar/karar veren dışarı
verilmiyor), doküman hash değişmezliği ve Faz 4 invariant'larının bozulmamış olması.

**Geliştirme sırasında bulunan hatalar:**

| Hata                                                                           | Kök neden                                                                                                                                           | Çözüm                                                                             |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Yetkilendirme sessizce yapılmıyordu (`payments_authorization_complete` ihlali) | `createIntent` ve `authorize` **aynı** idempotency anahtarını paylaşıyordu; sağlayıcı sözleşmesi gereği ikinci çağrıya birincinin sonucunu döndürdü | Her işlemin kendi anahtarı: `CREATE_INTENT` ve `AUTHORIZE` ayrıldı (ADR-0017 §4)  |
| Release bloklandığında gerekçe audit'e yazılmıyordu                            | Exception transaction **içinde** fırlatılıyordu; rollback audit kaydını da götürüyordu (Faz 3'teki hatanın aynısı)                                  | Blok kararı transaction'dan dönülüyor, commit ediliyor, hata dışarıda üretiliyor  |
| İkinci ödeme denemesi "geçersiz durum" hatası veriyordu                        | Yetkilendirme sonrası rezervasyon `SCHEDULED` olduğu için durum kontrolü önce tetikleniyordu                                                        | Canlı ödeme kontrolü durum kontrolünden öne alındı; istemci gerçek sebebi görüyor |
| Uyuşmazlık varken release "geçersiz durum" diyordu                             | Dondurma ödemeyi `DISPUTED` yapıyor, geçerlilik kontrolü blok kontrolünden önce çalışıyordu                                                         | Blok kontrolleri geçerlilik kontrolünden öne alındı                               |

## Faz 6 — Python AI / NLP ✅

**Kapsam:** FastAPI AI servisi; Türkçe serbest metin → structured request; Pydantic şema
doğrulama + confidence; `parser_version`; kural tabanlı baseline parser; evaluation dataset
yapısı (sentetik) + harness; NLP metrikleri (precision/recall/F1, slot F1); düşük
confidence'ta netleştirme/form fallback; prompt injection ve zararlı girdi testleri.

**Exit kriterleri (durum):**

- ✅ Baseline vs proposed karşılaştırması ölçüldü ve raporlandı:
  [EXP-001](../research/experiments/exp-001-nlp-baseline-vs-heuristic.md).
  Intent macro F1 0.55 → 0.98, slot macro F1 0.19 → 0.93, netleştirme recall'ı 0.50 → 1.00.
- ✅ Şemaya uymayan çıktı reddediliyor (T-13): bilinmeyen hizmet slug'ı, aralık dışı süre,
  tekrar eden yetkinlik ve sürümsüz yanıt hem AI servisinde hem core istemcisinde eleniyor.
- ✅ Düşük confidence'ta talep **oluşturulmuyor**, netleştirme soruluyor.
- ✅ Prompt injection veri olarak işleniyor (T-14): talimat eklenmiş metin, eklenmemişle
  **aynı** yapılandırılmış sonucu veriyor; şemada hedeflenebilecek bir alan yok.
- ✅ AI servisi down iken core akış form yoluyla çalışıyor (T-15); serbest metin yolu
  çökmüyor, `FORM_REQUIRED` dönüyor.
- ✅ Ayrıştırma deterministik: `today` enjekte ediliyor, sistem saatine bağlı değil.
- ✅ 91 AI testi + 141 core unit + 242 core integration; ruff/mypy/lint/typecheck temiz.

**Bu fazda ölçülen ama çözülmeyen:** güven kalibrasyonu (ECE/reliability diagram) yalnızca
ortalama fark olarak raporlandı — R-46, Faz 7.

**Faz 6 code review bulguları ve çözümleri** (bağımsız review agent'ı):

| Bulgu                                                                                                                                                                                                                                                       | Önem     | Çözüm                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Her `N-M` sayı aralığı saat aralığı sanılıyordu.** "Yarın **sabah** temizlik, 3-5 kişi gelecek" cümlesi 03:00-05:00 randevusu üretiyor, üstelik aynı cümledeki "sabah" eziliyordu — güven 0.74 ile eşiğin üstünde olduğu için netleştirme de sorulmuyordu | CRITICAL | Saat aralığı artık **açık gösterim** (`:`/`.`) istiyor. Çapasız aralık en sona alındı ve yalnızca "saat/arası" gibi bir çapa varken, "yaş/kişi/oda" gibi engelleyici yokken ve **düşük güvenle** kabul ediliyor                 |
| **Üç karakterlik ek bütçesi sıradan Türkçe çekimleri reddediyordu.** "Bebeğime bakacak birini arıyorum" hiç eşleşmiyor, dataset örneği `ca-003` sessizce kaçırılıyordu                                                                                      | CRITICAL | Ek, karakter sayısıyla değil **ek listesiyle** tanınıyor: kalıntı bilinen eklere ayrıştırılabiliyorsa çekimdir. Ünsüz yumuşaması için kök varyantları (`bebek`/`bebeg`, `cocuk`/`cocug`, `temizlik`/`temizlig`) sözlüğe eklendi |
| **NLP saatleri yerel, core UTC yazıyordu:** "sabah" diyen müşteriye 3 saat kaymış randevu; aynı tabloda form yolu ile metin yolu farklı zaman anlayışı üretiyordu                                                                                           | HIGH     | Saatler `SERVICE_TIMEZONE_OFFSET` (varsayılan `+03:00`) ile mutlak ana çevriliyor; gün sonu (24) ertesi güne taşıyor, bozuk tarih biçimi pencere üretmiyor. Üç integration testi eklendi                                        |
| **Deney raporunun hata analizi elle yazılmıştı ve yanlış örnekleri gösteriyordu** — bu yüzden gerçek bir hata (ek çözümleme) gözden kaçmıştı                                                                                                                | HIGH     | Hata analizi artık `collect_errors` ile **koddan üretiliyor** ve JSON rapora giriyor. İlk çalıştırmada bir **etiket hatası** yakaladı (`cl-007` "haftaya pazartesi")                                                            |
| Yükleme boyut sınırı gibi, `preferences` alanı da şemanın "serbest metin yok" güvencesini kâğıt üzerinde bırakıyordu (hiç doldurulmuyordu ama tipi serbest metindi)                                                                                         | MEDIUM   | Alan kaldırıldı; soft constraint'ler Faz 7'de **kapalı slug kümesiyle** dönecek. Alan **adlarını** değil **tiplerini** de denetleyen bir test eklendi                                                                           |
| "camiye" ek kurallarına göre geçerli bir çekim ve `cam-temizligi` yetkinliği üretiyordu                                                                                                                                                                     | MEDIUM   | Dil bilgisiyle çözülemeyen çakışmalar açık bir dışlama listesinde (`_TERM_EXCLUSIONS`)                                                                                                                                          |
| T-15 iki ayrı seviyede test ediliyordu; gerçek istemci + servis kararı **birlikte** hiç çalıştırılmıyordu                                                                                                                                                   | MEDIUM   | Gerçek `HttpNlpClient` ile yönlendirilemez adrese (TEST-NET-1) karşı uçtan uca test eklendi                                                                                                                                     |
| AI servisinin kendi yetkilendirmesi yoktu; yalnızca ağ politikasına güveniliyordu                                                                                                                                                                           | LOW      | `x-service-key` paylaşılan sır kontrolü (sabit zamanlı karşılaştırma); production'da **her iki serviste de zorunlu**                                                                                                            |

Reviewer'ın doğruladıkları: metrik hesaplamaları (per-class PRF, macro F1, slot F1)
doğru ve rapordaki sayılar yeniden üretilebiliyor; baseline gerçekten naif, yapay olarak
sakatlanmamış; core tarafındaki şema yeniden doğrulaması sağlam; `(structured_request IS
NULL) = (parser_version IS NULL)` her iki yolda korunuyor; form yolu NLP'ye hiç dokunmuyor
ve `degraded` bayrağı yetki/sahiplik davranışını değiştirmiyor; `turkish_lower`/`fold`
doğru.

**Geliştirme sırasında bulunan hatalar:**

| Hata                                                                                                   | Kök neden                                                                                                                     | Çözüm                                                                                            |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| "çamaşır" talebi `cam-temizligi` yetkinliği üretiyordu                                                 | Sonek toleransı sınırsızdı: katlanmış "camasir" içinde "cam" eşleşiyordu                                                      | Ek uzunluğu 3 karakterle ve Türkçe ek harfleriyle sınırlandı                                     |
| "TEMİZLİĞE İHTİYACIM VAR" hiç eşleşmiyordu                                                             | Sözlükte kök yerine tam biçim ("temizlik") vardı; ek almış biçim tutmuyordu                                                   | Sözlük kökleri ek toleransıyla uyumlu hale getirildi ("temizli")                                 |
| Doğru çekimserlik (hizmet yok → tahmin yok) accuracy'de hata sayılıyordu                               | Metrik yalnızca eşleşen tahminleri doğru sayıyordu                                                                            | `add_intent` doğru çekimserliği doğru sayıyor; aksi halde uydurma ödüllendirilirdi               |
| Integration paketi aralıklı olarak "socket hang up" ile düşüyordu (her ~3 koşumda bir, rastgele suite) | supertest, dinlemeyen bir sunucuya her istekte geçici port açıp kapatıyordu; paket büyüdükçe efemeral port baskısı oluştu     | Sunucu `createTestApp` içinde **suite başına bir kez** dinlemeye alınıyor; 9 ardışık koşum yeşil |
| Outbox testi aralıklı kırılıyordu                                                                      | Test, elle çağrılan `drain()`'in dönüş değerine bakıyordu; publisher arka planda da çalıştığı için olayı bazen o yayınlıyordu | Test artık **sonuca** bakıyor: satır `PUBLISHED` oluyor ve `attempts = 1` (tam olarak bir kez)   |
| `NODE_ENV=test` ayarlanınca seed betiği test koşumunu düşürdü                                          | `scripts/seed-catalog.ts` **import edildiğinde** `main()` çalıştırıyordu; testler `seedCatalog`'u içe aktarıyor               | `require.main === module` koşulu eklendi; import artık yan etkisiz                               |

**Bilinen, engelleyici olmayan durum:** `health-dependencies` suite'i "Jest did not exit"
uyarısı üretiyor. `--detectOpenHandles` hiçbir sızan handle raporlamıyor — erişilemeyen
Postgres testinin soketi Jest'in 1 saniyelik bekleme penceresinden biraz geç kapanıyor.
Testler kararlı; uyarı bastırılmadı, kaydedildi.

## Faz 7 — Matching & Optimization ✅

**Kapsam:** candidate retrieval (SQL/PostGIS); hard constraints; versiyonlu ağırlıklarla scoring;
OR-Tools optimization (assignment + time windows + capacity + travel); routing sağlayıcı
abstraction (gerçek ETA opsiyonel, fallback haversine); ranking; explainability üretimi;
`booking_match_results`; benchmark harness (Recall@K, acceptance rate, latency, travel/distance
reduction, constraint violation, runtime).

Ayrıntı: [matching.md](matching.md), [ADR-0018](adr/0018-matching-decision-chain.md).

**Exit kriterleri (durum):**

- ✅ **Determinizm** (T-17): sıralama katmanı koşulsuz deterministik — skor 4 haneye
  yuvarlanır, eşitlik `provider_id` ile çözülür, aday havuzunun geliş sırası sonucu
  etkilemez. Çözücü `num_workers=1` + sabit tohumla çalışır. **Sınır dürüstçe
  yazıldı:** optimizasyon zaman limitine takıldığında en iyi çabadır — ve tam bu
  yüzden sonuç `degraded` işaretlenir.
- ✅ **Hard constraint ihlali hiçbir skorla geçmiyor** (T-18): eleme skorlamadan önce
  ve ondan bağımsız çalışır; kısıtlar hem AI'da hem core'da değerlendirilir (ADR-0018 §3).
  Benchmark'ta proposed'ın ihlal oranı **0.00** (baseline 0.70).
- ✅ **Üç kademeli, işaretli bozulma** (T-16): routing → `ROUTING_UNAVAILABLE`,
  optimizasyon → `RANKED_FALLBACK`, AI servisi → `ENGINE_UNAVAILABLE`. Üçünde de
  kısıt kuralı geçerli. Core'un yedeği skor bileşenlerini **uydurmaz**.
- ✅ **Explainability kullanıcı verisi sızdırmıyor** (T-19): kapalı kod kümesi;
  müşteri yanıtı yalnızca seçilen sağlayıcıyı taşır, skor bileşeni içermez, mesafe
  kilometreye yuvarlanır (üçleme engeli). Tam sıralama yalnızca `ADMIN` uçunda.
- ✅ **Benchmark raporlandı:** [EXP-002](../research/experiments/exp-002-matching-baseline-vs-optimized.md).
  Recall@1 0.24 → 0.46, Recall@5 0.56 → 0.86, **geçerli** atama oranı 0.30 → 0.82,
  kısıt ihlali 0.70 → 0.00, optimizasyon p95 94 ms, fallback oranı 0.
- ✅ **R-46 kapandı:** ECE/MCE/Brier ölçülüyor ([EXP-003](../research/experiments/exp-003-confidence-calibration.md)).
- ✅ Aday havuzu sorgusu 2.000 sağlayıcı + 50.000 rezervasyonla ~10 ms; sağlayıcı ve
  rezervasyon tablolarında sequential scan yok.
- ✅ 220 AI testi + 180 core unit + 283 core integration; ruff/ruff format/mypy/eslint/tsc/prettier temiz.
- ✅ Servisler arası sözleşme iki taraflı test ediliyor
  (`packages/api-contracts/matching/`): core'un ürettiği gövde ve motorun gerçek
  yanıtı commit'li fixture'lardır. İki servis ayrı CI işlerinde koştuğu için, alan
  adlandırmasındaki sessiz bir sapma aksi hâlde yalnızca üretimde — kalıcı bozulmuş
  mod olarak — görünürdü.

**Bu fazda ölçülen ama çözülmeyen:**

- ❌ **Seyahat maliyeti hedefi tutmadı** (research-metrics §2.3). Proposed, baseline'dan
  %152 **fazla** yol üretiyor (eşleştirilmiş kıyasta da aynı yön). Neden tasarımda
  görünüyor: mesafe altı kriterden biri (ağırlık 0.15) ve amaç fonksiyonundaki yol
  cezası skor farklarının yanında etkisiz. Duyarlılık ölçüldü — `objective-v2-travel`
  seyahati %17.5 azaltıyor, bedeli ortalama sıranın 1.29 → 1.63 çıkması — ama
  **varsayılan değiştirilmedi** (metric shopping yasağı). → R-49.
- ❌ **Kalibrasyon ölçüldü, iyileştirilmedi:** `overall_score` kalibre bir olasılık
  değil (ECE 0.467). Skor bu yüzden müşteriye açılmıyor. → R-50.
- ⏸️ **Tekrarlayan müsaitlik (RRULE)** incelendi: matching recurrence **gerektirmiyor**
  (somut aralıklarla çalışıyor). Eklenmedi, risk **açıkça korundu** → R-47.
- ⚠️ Kısıt mantığı iki dilde yaşıyor ve birlikte güncellenmek zorunda → R-48.

**Faz 7 code review bulguları ve çözümleri** (bağımsız review + güvenlik agent'ları):

| Bulgu                                                                                                                                                                                                                                                                   | Önem     | Çözüm                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Günlük kapasite toplu çalıştırmada uygulanmıyordu.** `persist` her talep için bağımsız çalışıyor ve hepsi aynı bayat `dailyBookingCount` anlık görüntüsünü görüyordu: 5 talep aynı sağlayıcıya atanabiliyordu (kapasite 2). Çakışma engeli yakalamaz — saatler farklı | CRITICAL | Kapasite ve takvim **parti boyunca** biriktiriliyor; ayrıca yazma anında `FOR SHARE` ile **taze** okunuyor. `POST /matching/runs` için ilk kez integration testi yazıldı                                            |
| **Determinizm iddiası motor sınırında yanlıştı.** Aynı talep kümesi farklı sırada gönderilince 6 permütasyon 6 farklı sonuç veriyordu; üretimi yalnızca core'un `sort()` çağrısı kurtarıyordu                                                                           | HIGH     | Motor talepleri **kendisi** kanonik sıraya alıyor. Permütasyon testi eklendi (T-17)                                                                                                                                 |
| **`FEASIBLE` (zaman limiti doldu) `OPTIMIZED` olarak ve bozulmamış raporlanıyordu** — "kararların yüzde kaçı zaman limitine takıldı" ölçülemezdi                                                                                                                        | HIGH     | `OPTIMIZATION_TIMEOUT` ile işaretleniyor; atama korunuyor, iddia edilmeyen tek şey en iyilik                                                                                                                        |
| **Aday `LIMIT`'i elemeden önce uygulanıyordu:** "en yakın 50" havuzu doğrulanmamış/müsait olmayan sağlayıcılarla dolabilir, 200 m ötedeki uygun sağlayıcı hiç değerlendirilmezdi                                                                                        | HIGH     | Doğrulama, müsaitlik ve kapasite `LIMIT`'ten önceki `usable` CTE'sine taşındı. Yetkinlik bilinçli olarak kısıt katmanında bırakıldı (`eligible_count` sinyal taşısın)                                               |
| **Motordan gelen 4xx, kesintiden ayırt edilemiyordu.** Katalogda yeni bir hizmet açıp motorun kapalı slug kümesine eklemeyi unutmak "AI servisi kapalı" gibi görünür, o hizmet kalıcı olarak mesafeye göre eşleşirdi                                                    | HIGH     | `ENGINE_CONTRACT_MISMATCH` ayrı etiket + error seviyesinde log. Ayrıca iki taraflı slug sözleşmesi (`catalog-slugs.json`) ve her iki serviste test                                                                  |
| **AI çağrısı transaction içindeydi:** 10 sn'lik bir çağrı boyunca havuz bağlantısı + satır kilidi tutuluyordu; yavaşlayan AI servisi havuzu (10) tüketip **ilgisiz tüm endpoint'leri** durdururdu                                                                       | HIGH     | Akış üç faza ayrıldı: oku → (transaction yok) karar ver → yaz. Yazma fazı durumu, kapasiteyi ve müsaitliği **yeniden** okur                                                                                         |
| **Hizmet bölgeleri sınırsızdı ve mesafe onların ağırlık merkezinden hesaplanıyordu:** küçük daireler koyarak `distance_score` satın alınabilir, binlerce satırla bölgedeki her sorgu yavaşlatılabilirdi                                                                 | HIGH     | Bölge sayısı veritabanı trigger'ıyla 5; referans noktası **kapsayan** bölgenin merkezi (birleşimin değil); yazma uçlarına oran sınırı. Kalan yüzey R-51 olarak kaydedildi                                           |
| **Karar kaydı UPDATE'e kapalı ama DELETE'e açıktı**; `matching_runs` hiç korunmuyordu ve FK'ler `CASCADE` idi — tek bir talep silme işlemi tüm kanıtı yok ederdi                                                                                                        | MEDIUM   | Her iki tabloda `BEFORE UPDATE OR DELETE` trigger + `REVOKE`; FK'ler `RESTRICT`                                                                                                                                     |
| **Üretim doğrulayıcısı kapasite ve çakışmayı kontrol etmiyordu**, `violations` sabit 0 dönüyordu; bu kontroller yalnızca benchmark'ta vardı                                                                                                                             | MEDIUM   | Çözüm seviyesindeki kontroller `engine._verify`'a taşındı. İlk denemede tampon yanlış hesaplandı (ev→hizmet yolu, iki hizmet arası yol sanıldı) ve **geçerli** çözümler eleniyordu; yalnızca örtüşme kontrolü kaldı |
| **`preferredSkills` katalogla doğrulanmıyordu.** Profiline uydurma bir slug yazan tek müşteri kendi eşleştirmesini — ve toplu çalıştırmada aynı partideki diğerlerini — kalıcı olarak bozulmuş moda düşürebilirdi                                                       | MEDIUM   | Tercihler de katalogla karşılaştırılıyor; bilinmeyen olanlar **düşürülüyor** (zorunlu yetkinlikte hata, tercihte düşürme)                                                                                           |
| **AI servisinin belgelenen üst sınırları hiç uygulanmıyordu** (`optimization_max_*` tanımlıydı ama okunmuyordu); tek sınır çağıranın kendi sınırıydı                                                                                                                    | MEDIUM   | Uçta uygulanıyor (422) + şemada mutlak tavan. "Çağıranın sınırına güvenmek, ağ politikasına güvenmekle aynı hata"                                                                                                   |
| **Seyahat metriği yalnızca ilk ayağı ölçüyordu** ama "seyahat maliyeti" diye raporlanıyordu: rota optimizasyonu, onu hiç görmeyen bir metrikle yargılanıyordu                                                                                                           | MEDIUM   | `first_leg` / `realized_route` ayrıldı. **Asıl bulgu buradan çıktı:** yol cezası 12× → gerçekleşen rota **−%64**, atama/recall/ihlal sabit                                                                          |
| **Kabul oranı, seyahat metriğinin düzeltildiği seçilim yanlılığını taşıyordu**                                                                                                                                                                                          | MEDIUM   | Eşleştirilmiş kabul raporlanıyor; ham fark "unpaired" etiketli. Δ −0.102 → −0.056                                                                                                                                   |
| **EXP-002 metni kendi JSON'uyla uyuşmuyordu** (yalnızca gecikme sayıları)                                                                                                                                                                                               | MEDIUM   | Rapor yeniden üretildi; gecikmeler "makineye bağlı, tek yeniden üretilemeyen metrik" olarak işaretlendi. Doğrulama: 572 anahtar, 13 fark, **hepsi gecikme**                                                         |
| **`percentile` bankacı yuvarlamasıyla bir sıra yukarı kayıyordu**; `capacity_limit` üzerine yazıyordu (min yerine)                                                                                                                                                      | MEDIUM   | `math.ceil` + `min`                                                                                                                                                                                                 |
| Tekrar eden talep kimliği toplu istekte tek talep için **iki rezervasyon** üretebilirdi                                                                                                                                                                                 | MEDIUM   | `@ArrayUnique` + serviste tekilleştirme + veritabanında kısmi unique index (`uq_bookings_active_request`)                                                                                                           |
| Mesafe sınırı iki serviste ayrı yapılandırılıyordu ("aynı olmalı" notuyla); sapma sessiz olurdu                                                                                                                                                                         | MEDIUM   | Değer **istekle birlikte** taşınıyor; motorun ayarı yalnızca varsayılan                                                                                                                                             |
| Açıklamadaki mesafe 100 m çözünürlükteydi (üçleme) ve `PARTIAL_WINDOW_AVAILABLE` ham `availability_score` taşıyordu (takvim doluluğu)                                                                                                                                   | MEDIUM   | Mesafe 1 km kovasına; doluluk oranı açıklamadan kaldırıldı                                                                                                                                                          |
| Kapasite değişikliği ve bölge silme audit'e yazılmıyordu; `PROVIDER_CAPACITY_UPDATED` sabiti hiç kullanılmıyordu                                                                                                                                                        | LOW      | İkisi de kaydediliyor                                                                                                                                                                                               |
| Motor aynı sağlayıcıyı iki kez döndürürse `UNIQUE` ihlali tüm transaction'ı düşürürdü (müşteriye 500)                                                                                                                                                                   | LOW      | Core tekrarları kendisi eliyor                                                                                                                                                                                      |
| `_minutes_since` saniye taşıyan bir köke göre aşağı yuvarlıyordu: çözücü aralık başından 59 sn önce başlangıç önerebilir, doğrulayıcı reddederdi                                                                                                                        | LOW      | Kök dakikaya yuvarlanıyor                                                                                                                                                                                           |
| Yedek yolda ölü durum (`busy_by_provider`) ve `KeyError` fırlatan doğrudan indeksleme                                                                                                                                                                                   | LOW      | Kaldırıldı / `.get()` ile atlama                                                                                                                                                                                    |
| `GET /booking-requests/:id/match` her zaman `bookingId: null` dönüyordu                                                                                                                                                                                                 | LOW      | Talepten okunuyor                                                                                                                                                                                                   |
| EXP-003, matching skorunun ECE'sini "düzeltilmemiş kusur" gibi çerçeveliyordu; oysa skor olasılık olarak eğitilmiş değil                                                                                                                                                | LOW      | Kategori farkı olarak yeniden yazıldı; R-50 yalnızca NLP kalibrasyonunu kapsıyor, matching skoru R-49'a (ağırlık ayarı) bağlandı                                                                                    |

**Ayrıca Faz 7'de kapatılan, Faz 7'ye ait olmayan bir CI sorunu:** `uv run ruff format --check .`
adımı Faz 6'dan beri kırmızıydı (4 dosya). Formatlama uygulandı; Faz 7 kodunun bu
adımı yeşil bırakması için gereken asgari müdahaleydi.

**Reviewer'ların doğruladıkları:** CP-SAT modelinde yol cezası serbest değişkenden
beslenmiyor (çift yönlü reification doğru); çakışma + yol boşluğu gerçekten zorlanıyor
(34 km arayla iki iş → 88 dakika boşluk); bir rezervasyon iki kez atanamıyor; aralık
seçimi doğru reified; `localDayBounds` sabit ofset için doğru; multirange aritmetiği
doğru ve `bookings_no_overlap` predikatıyla birebir uyumlu; Python ↔ TypeScript kısıt
paritesi **sekiz kodun sekizinde de** semantik olarak aynı (sınır operatörleri dâhil);
benchmark yeniden üretilebilir ve gizli gerçek skor fonksiyonundan bağımsız; sonuçlar
cherry-pick edilmemiş (seyahat sonucu **başarısızlık** olarak raporlanıyor, daha iyi
görünen amaç sürümü varsayılan yapılmıyor); yetkilendirme sahiplik veri erişim
katmanında; servisler arası PII taşınmıyor; SQL injection yok; audit/outbox payload'ları
temiz; state machine atlanmıyor.

**Faz 7'de yapılan şema değişiklikleri:** `provider_services`, `matching_runs`,
`booking_match_results` (append-only), `provider_profiles.max_daily_bookings`,
`provider_service_areas.radius_meters`.

**Faz 6'dan taşınan ve Faz 7'de düzeltilen hata:** AI servisi "bugün"ü UTC gününden
çözüyordu. Yerel gece yarısı ile UTC gece yarısı arasındaki üç saatte "bugün temizlik"
diyen müşteri için **bir gün geriye** kayan bir tarih üretiyordu ve matching geçmişe
düşen bir pencere için aday arardı. Artık `AI_SERVICE_TIMEZONE_OFFSET` ile hizmet
zaman diliminde çözülüyor.

---

## Faz 8 — Safety

**Kapsam:** `safety_sessions`, `location_events` (partition + retention, `captured_at` +
`server_received_at` + oturum bazlı monoton sıra numarası + mock-location sinyali), `safety_events`;
geofence enter/exit; check-in/out; telemetri ingest (oturum kapalıyken ve bütünlük kontrolünden
geçmeyeni reddeder); rule engine (süre, hareketsizlik, rota sapması, geofence); ML anomaly scoring;
risk seviyeleri; deterministik panic flow (Faz 2'de kurulan outbox garantisiyle); safety event audit.

**Exit:** panic flow ML/dış servisler down iken çalışıyor ve p95 hedefini tutuyor (T-20);
oturum dışı telemetri reddediliyor (T-23); sahte/replay/geri tarihli telemetri reddediliyor (T-33);
retention job gerçekten siliyor (T-24); false positive oranı ölçüldü (T-22);
`SAFETY_HOLD` settlement'ı bloklıyor (T-11).

---

## Faz 9 — Event Driven Architecture

**Kapsam:** Pub/Sub topic/subscription topolojisi (domain başına topic, event tipi attribute —
ADR-0010 §8); `packages/api-contracts/events` şemaları; idempotent consumer'lar;
retry + DLQ; event observability (lag, DLQ derinliği, işlenme süresi).
Outbox/publisher/`processed_events` **Faz 2'de kuruldu**; bu fazda topoloji ve gözlemlenebilirlik eklenir.

**Exit:** duplicate event testi yan etki üretmiyor (T-25, T-38); outbox commit'li ama publish
edilmemiş event'i kurtarıyor (T-26, T-39); DLQ alarmı tanımlı; event kataloğu şemalarla uyumlu
(contract test).

---

## Faz 10 — Admin / Operations (API)

**Kapsam:** verification queue; provider yönetimi/onayı; booking operasyonları; ödeme operasyonları;
safety event yönetimi; dispute çözümü; matching analitiği; sistem sağlığı. Tüm admin aksiyonları
audit'li ve en az yetki ilkesine göre yetkilendirilmiş. **Görsel panel yok (Faz 15).**

**Exit:** her admin aksiyonu `audit_logs`'ta; SUPPORT rolü yıkıcı aksiyon yapamıyor (test);
hassas veri erişimi loglanıyor.

---

## Faz 11 — Analytics

**Kapsam:** event → BigQuery pipeline; operasyonel, matching, safety, AI ve ESG metrik modelleri;
payment reconciliation işi; dashboard-ready view'lar; retention/agregasyon.

**Exit:** metrikler tanımlarıyla eşleşiyor; kişisel veri analitiğe minimize edilerek gidiyor;
reconciliation farkı alarm üretiyor.

---

## Faz 12 — Security Hardening

**Kapsam:** RBAC yeniden gözden geçirme; Secret Manager/IAM/KMS; App Check zorunluluğu;
rate limiting + abuse senaryoları; audit tamlığı; hassas veri envanteri ve retention uygulanması;
dependency scanning + SAST; audit hash zinciri doğrulama işi + retention-locked export
(rol ayrımı Faz 2'de kuruldu — ADR-0013); identity HMAC anahtarı için **re-verification migration
prosedürü** (rotasyon bir seçenek değil — ADR-0004 §5); penetration test checklist.

**Exit:** SAST/dependency scan CI'da bloklayıcı; kritik/high bulgu yok veya gerekçeli istisna;
abuse senaryoları test edildi; retention gerçekten siliyor (T-24); audit hash zinciri kopukluğu
tespit ediliyor (T-36).

---

## Faz 13 — DevOps

**Kapsam:** üretim Dockerfile'ları (multi-stage, non-root); GitHub Actions tam pipeline;
Terraform ile Cloud Run, Cloud SQL, Memorystore, Pub/Sub, Storage, BigQuery, Secret Manager, KMS,
Monitoring; staging + production config ayrımı; alerting.

**Exit:** staging Terraform'dan sıfırdan kurulabiliyor; deploy rollback edilebiliyor;
smoke testler pipeline'da; alarmlar test edildi.

---

## Faz 14 — Performance & Reliability

**Kapsam:** load testing (100/250/500 eşzamanlı booking); concurrency testleri; p50/p95 ölçümü;
index tuning; Redis hit rate; Pub/Sub lag; failure recovery; retry/idempotency doğrulaması;
graceful degradation (AI down, Redis down, identity provider down, routing API down).

**Exit:** p50/p95 hedefleri karşılandı veya sapma gerekçeli; bağımlılık arızalarında sistem
kısmi çalışıyor ve veri bozulmuyor.

---

## Faz 15 — Web Frontend

Next.js + TypeScript: customer web, provider web, admin web. Mevcut API contract'lara göre.

---

## Faz 16 — Flutter Mobile

Customer + provider deneyimi: onboarding, identity, booking, matching, payment, service session,
safety, reviews, profile, notifications. Gerektiğinde native bridge.

---

## Faz 17 — Final E2E

Web + mobile + backend uçtan uca; production readiness review; TÜBİTAK demo senaryoları.
