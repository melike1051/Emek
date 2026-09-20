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

| Komut                                                      | Ne yapar                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------- |
| `npm run infra:up` / `infra:down`                          | Yerel altyapıyı başlatır/durdurur                           |
| `npm run infra:reset`                                      | Altyapıyı **veri hacmiyle birlikte** siler (yalnızca yerel) |
| `npm run migrate:up` / `migrate:down`                      | Şemayı ileri/geri alır                                      |
| `npm run dev --workspace=@emek/api`                        | Core API'yi watch modunda çalıştırır                        |
| `npm run lint` / `format` / `typecheck` / `build`          | Tüm workspace'lerde                                         |
| `npm test`                                                 | Unit testler (altyapı gerekmez)                             |
| `npm run test:integration`                                 | Integration testler (**altyapı gerekir**)                   |
| `cd services/ai && uv run fastapi dev app/main.py`         | AI servisini çalıştırır                                     |
| `cd services/ai && uv run pytest`                          | AI servisi testleri                                         |
| `cd services/ai && uv run ruff check . && uv run mypy app` | AI lint + typecheck                                         |

## Servis adresleri

| Servis                    | Adres                                                                  |
| ------------------------- | ---------------------------------------------------------------------- |
| Core API                  | http://localhost:3000/api/v1                                           |
| Core API health           | `GET /api/v1/health` (readiness), `GET /api/v1/health/live` (liveness) |
| AI servisi                | http://localhost:8000/api/v1                                           |
| AI servisi dokümantasyonu | http://localhost:8000/docs (production'da kapalı)                      |
| PostgreSQL                | `localhost:5432`, db `emek`, kullanıcı `emek`                          |
| Redis                     | `localhost:6379`                                                       |

## Test katmanları

- **Unit** (`npm test`): dış altyapı gerektirmez, saniyeler sürer.
- **Integration** (`npm run test:integration`): gerçek Postgres+PostGIS ve Redis'e karşı,
  `DATABASE_URL_TEST` veritabanında ve seri (tek worker) çalışır. Altyapı erişilemezse testler
  **atlanmaz, başarısız olur** — sessiz atlama migration ve constraint regresyonlarını saklar.
  Her test kendi verisini temizler; uygulama `configureApp()` ile kurulur, yani üretimde
  çalışan yapılandırmanın aynısı test edilir.

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
| Port çakışması (5432/6379)                               | Başka bir yerel Postgres/Redis çalışıyor; onu durdurun veya compose portunu değiştirin                   |
