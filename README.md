# Emek

Ev içi ve bakım hizmetlerinde müşterileri bağımsız kadın hizmet sağlayıcılarıyla buluşturan **iki
taraflı dijital hizmet pazaryeri**. Basit bir ilan uygulaması değildir: doğal dil talep işleme, çok
kriterli sağlayıcı eşleştirme, OR-Tools ile optimizasyon, hizmet oturumu bazlı güvenlik
telemetrisi, dijital ispat ve lisanslı ödeme kuruluşu üzerinden şartlı ödemeyi tek platformda
birleştirir.

Bağlam: TÜBİTAK 1812 kapsamında Ar-Ge yönü ölçülebilir bir platform — her algoritma
versiyonlanır, her deney kaydedilir ([docs/research/](docs/research/)).

## Durum

Faz 0–17 kod olarak tamamlandı; **yerel ortamda uçtan uca çalışır ve TÜBİTAK demosuna hazırdır.**
Pilot ve üretim için hazır **değildir**: altyapı gerçek GCP'de hiç uygulanmadı, ödeme ve kimlik
sağlayıcıları mock adapter arkasındadır, hukuki doğrulamalar bekler.
Karar ve go/no-go listesi: [production-readiness.md](docs/architecture/production-readiness.md).

| Faz  | Kapsam                                                                                                                                      | Durum                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 0–12 | Temel altyapı, core backend, kimlik, booking, ödeme, AI/NLP, eşleştirme, safety, event'ler, operasyon API, analytics, güvenlik sıkılaştırma | ✅ tamamlandı                                 |
| 13   | DevOps: Terraform, Cloud Run, staging/production                                                                                            | ⚠️ kod tamam, gerçek bulutta doğrulanmadı     |
| 14   | Performans ve dayanıklılık                                                                                                                  | ⚠️ ölçümler **yerel**                         |
| 15   | Web + operasyon paneli (Next.js)                                                                                                            | ⚠️ yerelde doğrulandı                         |
| 16   | Flutter mobil                                                                                                                               | ⚠️ simülatör/emülatörde doğrulandı            |
| 17   | Final E2E, production readiness, TÜBİTAK demo                                                                                               | ⚠️ kod + demo tamam; pilot/üretim hazır değil |

## Mimari özet

```
Flutter Mobil ────────────────────────┐
Next.js Web ──── (aynı-origin proxy) ─┼─→ NestJS Core API ─┬─→ PostgreSQL + PostGIS  (tek transactional kaynak)
Next.js Operasyon ─ (IAP arkasında) ──┘                    ├─→ Redis                 (cache / lock / oran sınırı)
                                                           ├─→ Pub/Sub               (event-driven yan akışlar)
                                                           ├─→ Cloud Storage         (kanıt dosyaları, private)
                                                           ├─→ BigQuery              (analytics, Ar-Ge metrikleri)
                                                           └─→ Python AI servisi     (NLP, eşleştirme, OR-Tools, anomali)
```

**Modular monolith (NestJS) + bağımsız AI servisi (FastAPI)**, Cloud Run üzerinde; Terraform +
GitHub Actions ile dağıtım. Kubernetes ve mikroservis yığını bilinçli olarak yoktur.

Değişmez kurallardan bazıları (tamamı [CLAUDE.md](CLAUDE.md)'de):

- Booking bir **state machine**'dir; geçişler tek merkezî tablodan geçer, çakışma veritabanı
  `EXCLUDE` kısıtıyla engellenir.
- Sağlayıcı seçimi **LLM'e bırakılmaz**: retrieval → hard constraints → scoring → optimizasyon →
  açıklanabilirlik; her karar `algorithm_version` ile saklanır.
- Emek escrow kurmaz; para lisanslı ödeme kuruluşunda tutulur ve uyuşmazlık penceresi geçmeden
  serbest bırakılmaz.
- Panik akışı deterministik ve anlıktır; 24 saat konum takibi yoktur, telemetri yalnız aktif
  hizmet oturumundadır.
- 1 insan = 1 hesap, veritabanı UNIQUE kısıtıyla; ham T.C. kimlik numarası saklanmaz.

## Repository yapısı

```
apps/mobile        Flutter (iOS + Android) — müşteri + sağlayıcı, hizmet oturumu telemetrisi
apps/web           Next.js — müşteri + sağlayıcı arayüzü
apps/admin         Next.js — operasyon paneli (IAP arkasında dağıtılır)
services/api       NestJS core backend
services/ai        Python + FastAPI — NLP, eşleştirme, optimizasyon, anomali
packages/          api-contracts (OpenAPI + event şemaları), api-client, shared-types, ui
infra/             terraform, docker, github-actions betikleri
e2e/               Playwright kritik akış testleri (web + admin + gerçek core API)
docs/              architecture (ADR'ler), api, database, security, research, testing
```

## Hızlı başlangıç

Gereksinimler: Node.js 22, Python 3.12 + [`uv`](https://docs.astral.sh/uv/), Docker + Compose.
Mobil için ayrıca Flutter 3.41.

```bash
cp .env.example .env
npm install && (cd services/ai && uv sync --all-groups)
npm run infra:up                                   # PostgreSQL + PostGIS + Redis
npm run migrate:up                                 # şema
npm run seed:catalog --workspace=@emek/api         # hizmet katalogu
npm run dev --workspace=@emek/api                  # core API → http://localhost:3000/api/v1
cd services/ai && uv run uvicorn app.main:app --port 8000   # AI servisi (ayrı terminal)
npm run dev --workspace=@emek/web                  # web → http://localhost:3001
npm run dev --workspace=@emek/admin                # operasyon → http://localhost:3004
```

Yerelde giriş **geliştirici (mock) kimliğiyle** yapılır. Demo aktörlerini hazır kurmak için:

```bash
npx tsx e2e/scripts/seed-demo.ts
```

Senaryolar: [demo-scenarios.md](docs/research/demo-scenarios.md). Ayrıntılı kurulum ve sorun
giderme: [local-development.md](docs/architecture/local-development.md).

## Testler

```bash
npm run lint && npm run typecheck && npm test      # hızlı kontroller (altyapı gerekmez)
npm run test:integration                           # gerçek Postgres + Redis
npm run test:e2e                                   # Playwright: API ayakta, yalnız yerel hedefler
cd services/ai && uv run pytest                    # AI servisi
cd apps/mobile && flutter test                     # mobil
npm run audit:deps && npm run sast                 # bağımlılık taraması + semgrep
```

CI her PR'da birim, entegrasyon, iki varyantlı E2E (AI servisi açık/kapalı), container derlemesi
ve güvenlik taramalarını koşar. Tam zincir senaryosu (talep → eşleşme → ödeme → hizmet günü →
onay → değerlendirme → mutabakat) `e2e/tests/web.full-lifecycle.spec.ts`'tedir.

## Dokümantasyon

| Doküman                                                                                | İçerik                                              |
| -------------------------------------------------------------------------------------- | --------------------------------------------------- |
| [CLAUDE.md](CLAUDE.md)                                                                 | Çalışma sözleşmesi, stack, değişmez mimari kurallar |
| [docs/architecture/adr/](docs/architecture/adr/)                                       | 26 bağlayıcı mimari karar                           |
| [docs/architecture/production-readiness.md](docs/architecture/production-readiness.md) | Hazırlık kararı ve go/no-go listesi                 |
| [docs/architecture/phase-plan.md](docs/architecture/phase-plan.md)                     | Faz planı ve exit kriterleri                        |
| [docs/architecture/local-development.md](docs/architecture/local-development.md)       | Kurulum, komutlar, sorun giderme                    |
| [docs/architecture/deployment.md](docs/architecture/deployment.md)                     | Dağıtım topolojisi, yayın akışı, rollback           |
| [docs/database/schema.md](docs/database/schema.md)                                     | Şema ve invariant'lar                               |
| [docs/api/error-codes.md](docs/api/error-codes.md)                                     | İş hata kodları                                     |
| [docs/security/rbac-matrix.md](docs/security/rbac-matrix.md)                           | Uç → rol/sahiplik matrisi                           |
| [docs/security/data-protection-baseline.md](docs/security/data-protection-baseline.md) | Veri sınıflandırma, KVKK, saklama                   |
| [docs/testing/test-strategy.md](docs/testing/test-strategy.md)                         | Test seviyeleri ve zorunlu senaryolar               |
| [docs/research/research-metrics.md](docs/research/research-metrics.md)                 | Ar-Ge metrikleri ve deneyler                        |
| [docs/research/demo-scenarios.md](docs/research/demo-scenarios.md)                     | TÜBİTAK demo senaryoları                            |
| [docs/research/technical-risks.md](docs/research/technical-risks.md)                   | Riskler, varsayımlar, açık noktalar                 |

Tek teknik referans: `docs/reference/Emek_Teknik_Mimari_ve_Gelistirme_Blueprint.pdf`.
