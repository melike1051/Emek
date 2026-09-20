# Emek

İki taraflı dijital hizmet pazaryeri platformu: ev içi ve bakım hizmetlerinde müşterileri bağımsız
kadın hizmet sağlayıcılarıyla buluşturur. Basit bir ilan uygulaması değil; doğal dil talep işleme,
çok kriterli provider matching, constraint-based optimizasyon, hizmet oturumu bazlı güvenlik
telemetrisi, dijital ispat ve şartlı ödeme orkestrasyonunu tek platformda birleştirir.

Bağlam: TÜBİTAK 1812 kapsamında geliştirilen Ar-Ge yönü güçlü bir platform.

## Mimari özet

```
Flutter Mobile ─┐
Next.js Web    ─┼─→ NestJS Core API ─┬─→ PostgreSQL + PostGIS   (transactional source of truth)
Next.js Admin  ─┘                    ├─→ Redis                  (cache / lock / idempotency)
                                     ├─→ Pub/Sub                (event-driven yan akışlar)
                                     └─→ Python AI Services     (NLP, matching, OR-Tools, anomaly)
```

Başlangıç mimarisi: **modular monolith + bağımsız AI/optimization servisleri**. Cloud Run üzerinde
Dockerized; Terraform + GitHub Actions ile dağıtım.

## Repository yapısı

```
apps/mobile      Flutter (Faz 16)
apps/web         Next.js customer/provider (Faz 15)
apps/admin       Next.js admin/operations (Faz 15)
services/api     NestJS core backend
services/ai      Python + FastAPI (NLP, matching, optimization, anomaly)
packages/        api-contracts, shared-types, config
infra/           terraform, docker, github-actions
docs/            architecture, api, database, security, research, testing
```

## Geliştirme durumu

| Faz   | Kapsam                                                                            | Durum         |
| ----- | --------------------------------------------------------------------------------- | ------------- |
| 0     | Repository & architecture audit                                                   | ✅ tamamlandı |
| 1     | Foundation (monorepo, DB, Redis, Docker, CI)                                      | ✅ tamamlandı |
| 2     | Core backend (auth, RBAC, profiller, audit/outbox/idempotency altyapısı)          | sırada        |
| 3-14  | Identity, booking, payment, AI, safety, events, ops, güvenlik, devops, performans | planlandı     |
| 15-17 | Web frontend, Flutter mobile, final E2E                                           | planlandı     |

Frontend **bilinçli olarak** Faz 15'e kadar geliştirilmez (bkz. ADR-0011).

## Dokümantasyon

| Doküman                                                                                | İçerik                                              |
| -------------------------------------------------------------------------------------- | --------------------------------------------------- |
| [CLAUDE.md](CLAUDE.md)                                                                 | Çalışma sözleşmesi, stack, değişmez mimari kurallar |
| [docs/architecture/initial-assessment.md](docs/architecture/initial-assessment.md)     | Mevcut durum, boşluk analizi, anti-hedefler         |
| [docs/architecture/adr/](docs/architecture/adr/)                                       | 15 bağlayıcı mimari karar                           |
| [docs/architecture/local-development.md](docs/architecture/local-development.md)       | Kurulum, komutlar, sorun giderme                    |
| [docs/database/schema.md](docs/database/schema.md)                                     | Şema ve invariant'lar                               |
| [docs/architecture/phase-plan.md](docs/architecture/phase-plan.md)                     | Faz planı ve exit kriterleri                        |
| [docs/architecture/coding-conventions.md](docs/architecture/coding-conventions.md)     | Kod, hata, commit konvansiyonları                   |
| [docs/architecture/event-catalog.md](docs/architecture/event-catalog.md)               | Event sözlüğü                                       |
| [docs/testing/test-strategy.md](docs/testing/test-strategy.md)                         | Test seviyeleri ve zorunlu senaryolar               |
| [docs/security/data-protection-baseline.md](docs/security/data-protection-baseline.md) | Veri sınıflandırma, KVKK, retention                 |
| [docs/research/technical-risks.md](docs/research/technical-risks.md)                   | Riskler ve varsayımlar                              |
| [docs/research/research-metrics.md](docs/research/research-metrics.md)                 | Ar-Ge metrikleri ve deney çerçevesi                 |

Tek teknik referans: `Emek_Teknik_Mimari_ve_Gelistirme_Blueprint.pdf`.

## Kurulum

Gereksinimler: Node.js 22, Python 3.12 (`uv`), Docker + Compose.

```bash
cp .env.example .env
npm install
(cd services/ai && uv sync --all-groups)
npm run infra:up      # PostgreSQL+PostGIS + Redis
npm run migrate:up    # şema
```

Sonra: `npm run dev --workspace=@emek/api` (http://localhost:3000/api/v1) ve
`cd services/ai && uv run fastapi dev app/main.py` (http://localhost:8000/api/v1).

Ayrıntı, komut listesi ve sorun giderme: [docs/architecture/local-development.md](docs/architecture/local-development.md).
