# Coding Conventions

## 1. Genel ilkeler

- Kod yazmadan önce mevcut kodu oku. Bilmediğin dosya/mimari hakkında varsayım yapma.
- Gereksiz abstraction yazma. Üç benzer satır, erken soyutlamadan iyidir.
- Olmayan senaryolar için hata yönetimi/fallback yazma. Doğrulama sistem sınırlarında yapılır
  (kullanıcı girdisi, dış API, webhook), iç çağrılarda değil.
- Varsayılan: **yorum yazma**. Yorum yalnızca *neden*in belirsiz olduğu yerde (gizli kısıt,
  ince invariant, belirli bir bug için workaround). Ne yaptığını anlatan yorum yazılmaz.
- Geriye dönük uyumluluk şivleri, kullanılmayan `_var` yeniden adlandırmaları, "removed" yorumları yok.
  Kullanılmayan kod silinir.
- Hard-code yok. Sadece testi geçirmek için özel-case çözüm yok.

## 2. TypeScript / NestJS

**Yapı** — her domain modülü: `controller/`, `service/`, `repository/`, `entity/`, `dto/`,
`events/`, `__tests__/`. Domain mantığı controller'a gömülmez; controller yalnızca HTTP sınırıdır.

**Modül sınırları** — bir modül başka modülün repository'sine, entity'sine veya DB tablosuna
doğrudan erişemez. Yalnızca public service arayüzü veya domain event kullanılır.

**Tipler**

- `strict: true`. `any` yasak; kaçınılmazsa `unknown` + narrowing.
- Dış dünyadan gelen hiçbir veri tipine güvenilmez: request body, webhook, AI servis yanıtı,
  event payload — hepsi runtime şema doğrulamasından (class-validator / zod) geçer.
- Para **her zaman** minor unit `bigint`/`BIGINT` (`price_minor`, `amount_minor`) + `currency`.
  Float ile para hesabı yasak.
- Zaman `TIMESTAMPTZ`; uygulama içinde UTC, sunumda kullanıcı zaman dilimi. Naive datetime yok.

**İsimlendirme**

- Dosya: `kebab-case.ts` (`booking-state.service.ts`). Class: `PascalCase`. Değişken/fonksiyon: `camelCase`.
- Enum değerleri ve state adları: `SCREAMING_SNAKE_CASE` (DB ile aynı).
- DTO: `CreateBookingRequestDto`, `BookingResponseDto`. Event: `BookingCreated` (PascalCase, geçmiş zaman).
- Boolean: `isActive`, `hasVerifiedIdentity`, `canRelease`.

**Hata yönetimi**

- Kullanıcıya dönen her iş hatası bir **business error kodu** taşır:
  `IDENTITY_ALREADY_REGISTERED`, `PROVIDER_NOT_AVAILABLE`, `BOOKING_CONFLICT`, `INVALID_STATE_TRANSITION`,
  `PAYMENT_FAILED`, `SAFETY_SESSION_NOT_ACTIVE`, `DISPUTE_ALREADY_OPEN`, `VERIFICATION_REQUIRED`,
  `RATE_LIMITED`. Yeni kod `docs/api/error-codes.md`'ye eklenir.
- Ham exception mesajı, stack trace veya SQL hatası **hiçbir koşulda** client'a dönmez.
- HTTP: 400 validation, 401 auth yok, 403 yetki yok, 404 yok/erişilemez, 409 çakışma/state,
  422 iş kuralı, 429 rate limit, 5xx beklenmeyen.

**Veritabanı**

- Şema değişikliği yalnızca versiyonlu migration ile; elle DDL yok. Her migration geri alınabilir.
- Invariant'lar DB'de de zorlanır: NOT NULL, CHECK, UNIQUE (gerektiğinde partial), EXCLUDE, FK.
  Uygulama kontrolü ilk, DB constraint son savunmadır.
- Ham SQL parametrelidir; string birleştirme ile sorgu kurulmaz.
- Coğrafi kolonlar `GEOGRAPHY(...,4326)` + GIST indeks.

## 3. Python / FastAPI

- Python 3.12, `uv` ile bağımlılık yönetimi, `ruff` (lint+format), `mypy --strict`.
- Tüm request/response modelleri Pydantic v2. LLM/model çıktısı **mutlaka** şemaya parse edilir;
  parse hatası açık hata döndürür, sessizce varsayılana düşmez.
- `services/ai` domain state yazmaz; DB'ye yalnızca okuma yetkili rolle erişir.
- Deterministik olması gereken fonksiyonlarda rastgelelik sabit seed ile kontrol edilir.
- Model/algoritma sürümü her yanıtta döner (`parser_version`, `algorithm_version`, `model_version`).
- Uzun süren optimizasyonlarda zaman limiti zorunlu; limit aşılırsa kısmi/fallback sonuç
  **işaretlenerek** döner, sessizce değil.
- Yapı: `app/api/`, `app/domain/`, `app/nlp/`, `app/matching/`, `app/optimization/`,
  `app/anomaly/`, `app/config.py`, `tests/`.

## 4. API sözleşmesi

- Versiyon: `/api/v1`. Breaking değişiklik yeni sürüm gerektirir.
- Sözleşme `packages/api-contracts` altında tek doğruluk kaynağıdır; client'lar buradan üretilir.
- Alan adları JSON'da `camelCase`, DB'de `snake_case`; dönüşüm tek bir mapping katmanında.
- Liste endpoint'leri sayfalanır (cursor tabanlı tercih edilir); sınırsız liste dönmez.
- Yan etkili endpoint'ler `Idempotency-Key` header'ını destekler.

## 5. Loglama ve gözlemlenebilirlik

- Structured JSON log. Her istekte `request_id`, varsa `user_id`, `booking_id`.
- **Loglanmaz:** token, secret, kart verisi, ham kimlik bilgisi, tam konum geçmişi, OTP kodu,
  `raw_text` içindeki kişisel veri (gerektiğinde maskelenir). Koordinat anahtarları
  (`latitude`, `longitude`, `lat`, `lon`, `lng`) Faz 8'den itibaren redaksiyon listesindedir
  (`common/logging/redact.ts`): güvenlik kodu koordinat loglamaz, liste kazara sızıntıya
  karşı ikinci katmandır.
- Safety metrikleri sabit adlı yapılandırılmış log satırlarıdır (`safety.*`,
  `safety/safety-metrics.ts`); koordinat ve kişi kimliği taşımaz.
- Kritik işlemler (`audit_logs`): rol değişimi, verification onayı/reddi, ödeme durumu değişimi,
  admin müdahalesi, dispute çözümü, recovery, hassas veri erişimi.
- Metrikler: p50/p95 latency, error rate, event lag, cache hit rate, panic flow latency.

## 6. Test

Kural ve zorunlu senaryolar: `docs/testing/test-strategy.md`. Özet:

- Test feature ile birlikte yazılır. Testsiz feature tamamlanmış sayılmaz.
- Test geçsin diye test silinmez/zayıflatılmaz; başarısız test bir bulgudur.
- Integration testler gerçek Postgres ve Redis'e karşı çalışır (mock DB ile değil).

## 7. Git

- Branch: `feat/`, `fix/`, `chore/`, `docs/`, `refactor/`, `test/` + kısa açıklama.
- Commit: Conventional Commits — `feat(bookings): add state transition guard`.
  İmperatif, *neden*e odaklı gövde. Faz bilgisi gövdede belirtilebilir.
- Secret asla commit edilmez; `.env.example` gerçek değer içermez.
- Destructive git işlemi (force push, reset --hard, checkout --) kullanıcı onayı olmadan yapılmaz.
- Commit öncesi `git status` kontrol edilir; geniş `git add` sonrası içerik gözden geçirilir.

## 8. Dokümantasyon

- Her major feature için: purpose, architecture, data flow, API, failure cases, security, testing, metrics.
- Yeni mimari karar → ADR. Mevcut ADR değiştirilmez, `Superseded by` ile yenisi yazılır.
- Hukuki doğrulama gerektiren varsayım kodda ve dokümanda `TODO(legal):` ile işaretlenir.
- Planlama/analiz dokümanı istenmeden üretilmez; faz çıktısı olanlar hariç.
