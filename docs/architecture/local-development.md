# Local Development

## Önkoşullar

| Araç    | Sürüm          | Not                                           |
| ------- | -------------- | --------------------------------------------- |
| Node.js | 22 (`.nvmrc`)  | ≥ 20.11 zorunlu                               |
| npm     | 10+            | workspaces kullanılır                         |
| uv      | 0.12+          | Python toolchain; sistem Python'u kullanılmaz |
| Docker  | Compose v2 ile | Postgres+PostGIS ve Redis için                |

Python **3.12**'ye pinlidir (`services/ai/.python-version`). Yerel sistem Python'u (ör. 3.9)
hiçbir yerde kullanılmaz — sürüm farkı "benim makinemde çalışıyor" hatalarının birincil kaynağıdır.

## Kurulum

```bash
cp .env.example .env
npm install
(cd services/ai && uv sync --all-groups)
npm run infra:up          # Postgres+PostGIS + Redis (emek + emek_test veritabanları)
npm run migrate:up        # şemayı kur
```

`infra:up` iki veritabanı oluşturur: `emek` (geliştirme) ve `emek_test` (integration testleri).
Testler şemayı sıfırladığı için ayrımı korumak zorunludur; test koşucusu adı `_test` ile
bitmeyen bir veritabanına bağlanmayı **reddeder**. Mevcut bir volume üzerinde `emek_test`
yoksa `npm run infra:reset` ile temiz kurulum yapın.

Pub/Sub emulator opsiyoneldir (imaj ~1.5GB) ve Faz 2'de outbox ile devreye girer:

```bash
npm run infra:up:events
```

## Günlük komutlar

| Komut                                                                | Ne yapar                                                                      |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `npm run infra:up` / `infra:down`                                    | Yerel altyapıyı başlatır/durdurur                                             |
| `npm run infra:reset`                                                | Altyapıyı **veri hacmiyle birlikte** siler (yalnızca yerel)                   |
| `npm run migrate:up` / `migrate:down`                                | Şemayı ileri/geri alır                                                        |
| `npm run dev --workspace=@emek/api`                                  | Core API'yi watch modunda çalıştırır                                          |
| `npm run dev --workspace=@emek/web`                                  | Web uygulaması (müşteri + sağlayıcı), `:3001` — bkz. aşağıda                  |
| `npm run lint` / `format` / `typecheck` / `build`                    | Tüm workspace'lerde                                                           |
| `npm test`                                                           | Unit testler (altyapı gerekmez)                                               |
| `npm run test:integration`                                           | Integration testler (**altyapı gerekir**)                                     |
| `cd services/ai && uv run uvicorn app.main:app --reload --port 8000` | AI servisini çalıştırır (`fastapi dev` için `fastapi[standard]` kurulu değil) |
| `cd services/ai && uv run pytest`                                    | AI servisi testleri                                                           |
| `cd services/ai && uv run ruff check . && uv run mypy app`           | AI lint + typecheck                                                           |
| `cd services/ai && uv run python -m app.evaluation.run`              | NLP deneyi (EXP-001) + kalibrasyon (EXP-003) — JSON çıktı                     |
| `cd services/ai && uv run python -m app.evaluation.matching.run`     | Matching benchmark'ı (EXP-002) — JSON çıktı                                   |
| `npm run exp:safety --workspace=@emek/api`                           | Safety deneyi (EXP-004) — core + AI modeli, JSON dosyaya yazar                |
| `npm run exp:safety:latency --workspace=@emek/api`                   | Safety gecikme ölçümü (**test DB'sini sıfırlar**, altyapı gerekir)            |

## Servis adresleri

| Servis                    | Adres                                                                  |
| ------------------------- | ---------------------------------------------------------------------- |
| Core API                  | http://localhost:3000/api/v1                                           |
| Core API health           | `GET /api/v1/health` (readiness), `GET /api/v1/health/live` (liveness) |
| Web (müşteri + sağlayıcı) | http://localhost:3001 — `/api/v1/*` core API'ye proxy'lenir            |
| Admin (operasyon)         | http://localhost:3004 — yalnız ADMIN/SUPPORT, `/api/v1/*` proxy        |
| AI servisi                | http://localhost:8000/api/v1                                           |
| AI servisi dokümantasyonu | http://localhost:8000/docs (production'da kapalı)                      |
| PostgreSQL                | `localhost:5432`, db `emek`, kullanıcı `emek`                          |
| Redis                     | `localhost:6379`                                                       |

## Web uygulaması (Faz 15)

```bash
cp apps/web/.env.example apps/web/.env.local   # NEXT_PUBLIC_AUTH_MODE=mock
npm run dev --workspace=@emek/api              # :3000 (AUTH_PROVIDER=mock)
npm run dev --workspace=@emek/web              # :3001
```

- Tarayıcı yalnızca `:3001`'e konuşur; Next.js `/api/v1/*`'i `API_ORIGIN`'e iletir — backend'de
  CORS yoktur (ADR-0024 §5).
- Mock modda giriş ekranı **geliştirici girişi** gösterir: herhangi bir kimlik + geçerli bir cep
  telefonu (backend hesap oluştururken iletişim bilgisi ister — `AUTH_CONTACT_REQUIRED`). Aynı kimlik
  her seferinde aynı kullanıcıyı açar. `NEXT_PUBLIC_AUTH_MODE=mock` production build'de reddedilir.
- Firebase modunda `NEXT_PUBLIC_FIREBASE_*` zorunludur; `NEXT_PUBLIC_APP_CHECK_SITE_KEY` boşsa App
  Check başlatılmaz (backend `APP_CHECK_ENABLED=false` olmalı).
- **Kanıt yükleme (sağlayıcı):** tarayıcı dosyayı imzalı URL'e doğrudan yükler. Yerelde mock
  storage'ın URL'leri `.env`'de `STORAGE_MOCK_PUBLIC_BASE_URL=/api/v1/_dev/storage` ile web'in
  aynı-origin proxy'sinden `DevStorageController`'a ulaşır (yalnız `STORAGE_PROVIDER=mock`; dağıtılan
  ortamda config mock'u reddeder). Değişken yoksa varsayılan `https://storage.local` hiçbir yere
  çözülmez ve yükleme "Dosya yüklenemedi" ile biter. Mock storage bellektedir: API yeniden başlayınca
  dosyalar gider, `sha256` kayıtları kalır.
- Eşleştirme (`POST /booking-requests/{id}/match`) AI servisini (`:8000`) çağırır; servis kapalıyken
  sonuç `degraded` döner.
- `apps/web/AGENTS.md` (+ `CLAUDE.md`) `next dev` tarafından üretilir; kurulu Next.js sürümünün
  dokümanına (`node_modules/next/dist/docs/`) işaret eder.

## Admin uygulaması (Faz 15)

```bash
cp apps/admin/.env.example apps/admin/.env.local   # NEXT_PUBLIC_AUTH_MODE=mock
npm run dev --workspace=@emek/admin                # :3004
```

- Yalnız `ADMIN`/`SUPPORT` rolü olan kullanıcı içeri girer; rol ataması web'den yapılmaz (seed/betik).
- SUPPORT oturumunda yazma düğmeleri hiç görünmez. Yazma eylemi belirsiz hatayla (ağ/5xx) biterse
  panel kilitlenir; değişiklik için paneli kapatıp kaydın güncel durumuna bakın.

## Mobil uygulama (Faz 16)

Flutter 3.41.7 (CI ile aynı), Xcode + CocoaPods (iOS), Android SDK. Yapılandırma yalnız
`--dart-define` ile (ADR-0025 §7); Firebase dosyaları repoya girmez.

```bash
cd apps/mobile
flutter pub get
flutter analyze && flutter test
# iOS simülatörü (localhost) — core API ayakta, AUTH_PROVIDER=mock:
flutter run -d <simülatör> --dart-define=AUTH_MODE=mock --dart-define=API_BASE_URL=http://localhost:3000
# Android emülatörü: API_BASE_URL=http://10.0.2.2:3000
# Simülatör testleri gerçek yerel backend ister: core API (kanıt yüklemesi için
# STORAGE_MOCK_PUBLIC_BASE_URL=/api/v1/_dev/storage — `.claude/launch.json` "api-e2e", :3002),
# AI servisi (:8000) ve seed'ler. Seed çıktıları --dart-define olarak verilir:
A=$(npx tsx e2e/scripts/seed-mobile-provider.ts)            # müşteri akışı (kökten)
B=$(npx tsx e2e/scripts/seed-mobile-provider-booking.ts)    # sağlayıcı akışı
flutter test integration_test -d <simülatör> --dart-define=API_BASE_URL=http://localhost:3002 \
  $(python3 -c "import json,sys; d={**json.loads(sys.argv[1]),**json.loads(sys.argv[2])}; print(' '.join(f'--dart-define={k}={v}' for k,v in d.items()))" "$A" "$B")
```

- Düz http yalnız yerel adreslere açıktır (iOS `NSAllowsLocalNetworking`, Android debug
  `network_security_config`); release build `https` ve Firebase ister, mock'u reddeder.
- Telemetri simülatör testi (`integration_test/telemetry_flow_test.dart`) gerçek konum kaynağını
  kullanır: `xcrun simctl location <udid> set <lat>,<lon>` ile konum verilir. Test çalıştırması
  uygulamayı yeniden kurar ve izin sıfırlanır; iOS izin penceresi testi bekletir. İzni, test
  sürerken arka planda tekrar verin:
  `while true; do xcrun simctl privacy <udid> grant location tr.emek.emekMobile; sleep 1; done &`
- zsh tırnaksız `$DEGISKEN`'i kelimelere **bölmez**: argümanları bir değişkende toplarsanız
  `${=ARGS}` kullanın (yukarıdaki gibi `$(...)` doğrudan bölünür).
- `E2E_PROVIDER_NAME` boşluk içerir ("E2E Sağlayıcı …"): `$(...)` ile bölünen argüman listesi
  onu parçalar ve `flutter test` "integration tests and unit tests cannot be run in a single
  invocation" hatası verir. Argümanları satır satır bir diziye okuyun (`args+=("$l")`,
  `"${args[@]}"`). Sağlayıcı ve telemetri testleri aynı randevuyu ilerlettiği için her biri
  kendi `seed-mobile-provider-booking` çıktısıyla ayrı koşturulur.
- Testten önce API'nin **güncel kodla** çalıştığını doğrulayın: izlemesiz (`ts-node`) açık
  kalmış bir instance eski kodu sunar ve hatalar yanıltıcı olur (Faz 16 adım 6'da giriş 500
  verdi). Şüphede taze bir instance açın (`.claude/launch.json` "api-verify", :3006).
- Eski bir `.env` `STORAGE_MOCK_PUBLIC_BASE_URL` içermiyorsa mock storage yükleme adresi
  `https://storage.local` olur ve cihazdan/tarayıcıdan kanıt yüklemesi ağ hatası verir;
  `.env.example`'daki değeri ekleyin.
- Android emülatörü (API 35, `system-images;android-35;google_apis;arm64-v8a`, ~6 GB disk):
  `avdmanager create avd -n emek_api35 -k "system-images;android-35;google_apis;arm64-v8a" -d pixel_7`,
  `emulator -avd emek_api35`. Testlerde `API_BASE_URL=http://10.0.2.2:<port>`. Telemetri testi için
  izin ve konum test sürerken döngüde verilir (kurulum izni sıfırlar):
  `while true; do adb shell pm grant tr.emek.emek_mobile android.permission.ACCESS_FINE_LOCATION; adb emu geo fix <lon> <lat>; sleep 2; done &`
  Android'de klavye ve kısa ekran butonları görünümden çıkarır: testler dokunmadan önce
  `ensureVisible` ile kaydırır.
- Xcode 27 ile `flutter build ios --simulator` Flutter'ın `lipo -verify_arch` adımında kırılır
  (çoklu mimari sözdizimi değişti); `flutter run` ve `flutter test integration_test` çalışır.

## Test katmanları

- **Unit** (`npm test`): dış altyapı gerektirmez, saniyeler sürer.
- **Integration** (`npm run test:integration`): gerçek Postgres+PostGIS ve Redis'e karşı,
  `DATABASE_URL_TEST` veritabanında ve seri (tek worker) çalışır. Altyapı erişilemezse testler
  **atlanmaz, başarısız olur** — sessiz atlama migration ve constraint regresyonlarını saklar.
  Her test kendi verisini temizler; uygulama `configureApp()` ile kurulur, yani üretimde
  çalışan yapılandırmanın aynısı test edilir.
- **E2E** (`npm run test:e2e`, Faz 15): Playwright, `e2e/`. Core API'yi **siz** başlatırsınız
  (`AUTH_PROVIDER=mock`, `PAYMENT_PROVIDER=mock`, `APP_CHECK_ENABLED=false`, katalog seed'li);
  web (:3001) ve admin (:3004) çalışmıyorsa Playwright `next dev` ile başlatır. Geliştirme
  veritabanına (`emek`) `e2e-` önekli kullanıcılar ve rastgele konumlu sağlayıcılar yazar, silmez.
  Yerel oran sınırı sayaçlarını (`ratelimit:*`) her testten önce sıfırlar. İlk kurulum:
  `npx --workspace=@emek/e2e playwright install chromium`. AI servisi kapalıysa eşleştirme yedek
  yoldan geçer; test bunu kabul eder. `E2E_REQUIRE_AI=true` iken tam zincir testi
  (`web.full-lifecycle.spec.ts`) yedek yola düşen eşleşmeyi başarısız sayar — AI servisini
  başlatıp öyle koşun. CI'da (`ci.yml` `e2e` işi) iki varyant da her PR'da koşar (Faz 17).
- **Demo verisi** (`npx tsx e2e/scripts/seed-demo.ts`, Faz 17): TÜBİTAK demo senaryolarının
  aktörlerini kurar ve giriş bilgilerini yazdırır; yalnız yerel hedeflere yazar.
  Bkz. [demo-scenarios.md](../research/demo-scenarios.md).

## Yapılandırma

Tüm ortam değişkenleri `.env.example` içinde listelidir ve başlangıçta şema ile doğrulanır
(`services/api/src/common/config/env.schema.ts`, `services/ai/app/config.py`).
Eksik veya geçersiz değerde servis **başlamaz**.

`.env` commit edilmez. `IDENTITY_PROVIDER=mock` / `PAYMENT_PROVIDER=mock` yalnızca
development/test içindir; `NODE_ENV=production` ile birlikte verilirse servis başlamayı reddeder
(ADR-0005, ADR-0009).

## Sorun giderme

| Belirti                                                  | Neden / çözüm                                                                                            |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `EnvValidationError` ile başlamıyor                      | `.env` eksik veya alan geçersiz; hata mesajı alan adını söyler (değerleri loglamaz)                      |
| Integration test "PostgreSQL erişilemiyor"               | `npm run infra:up` çalıştırılmamış veya container health'e geçmemiş                                      |
| Integration test "_test ile biten veritabanında çalışır" | `.env` içinde `DATABASE_URL_TEST` eksik veya geliştirme veritabanını gösteriyor                          |
| `emek_test` veritabanı yok                               | Volume eski; `npm run infra:reset` (yerel veriyi siler) veya elle `CREATE DATABASE emek_test OWNER emek` |
| `postgis_version()` hatası                               | Migration çalışmamış; `npm run migrate:up`                                                               |
| Health `degraded` dönüyor                                | Gövdedeki `checks` hangi bağımlılığın `down` olduğunu söyler                                             |
| Web'den dosya yüklenemiyor (`UPLOAD_FAILED`)             | `.env`'de `STORAGE_MOCK_PUBLIC_BASE_URL=/api/v1/_dev/storage` yok; ekleyip API'yi yeniden başlatın       |
| Port çakışması (5432/6379)                               | Başka bir yerel Postgres/Redis çalışıyor; onu durdurun veya compose portunu değiştirin                   |

## Deney çıktılarını yenileme

Deney raporlarındaki sayılar elle yazılmaz; JSON çıktıdan üretilir (ADR-0012 §4):

```bash
cd services/ai
uv run python -m app.evaluation.matching.run > ../../docs/research/experiments/exp-002-matching-baseline-vs-optimized.json
```

Safety deneyi (EXP-004) iki servisi birlikte kullanır: senaryolar core'un saf
fonksiyonlarından geçer, anomali skorları AI servisinin modelinden alınır. Çıktıyı
doğrudan `docs/research/experiments/exp-004-safety-anomaly.json` dosyasına yazar:

```bash
npm run exp:safety --workspace=@emek/api
npm run exp:safety:latency --workspace=@emek/api   # yerel altyapı açık olmalı; emek_test'i sıfırlar
```

Benchmark tohumları sabittir (`SCENARIOS`), bu yüzden aynı kod aynı sayıları üretir.
Sayı değiştiyse **algoritma değişmiştir** — ya rapor ya sürüm etiketi güncellenmeli.

## Safety izleyicisi (Faz 8)

API süreci bir arka plan izleyicisi çalıştırır (değerlendirmesi gelen oturumlar, süresi
dolan oturumlar, retention, aylık `location_events` partition'ı). Yerelde kapatmak için
`SAFETY_MONITOR_ENABLED=false`; integration testleri onu zaten kapatır. AI servisi
çalışmıyorsa değerlendirme kurallarla devam eder ve `safety.anomaly.unavailable` metrik
logu üretir — bu bir hata değil, beklenen bozulmuş moddur.
