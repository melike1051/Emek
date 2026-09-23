# CLAUDE.md — Emek Platform

Bu dosya, bu repository üzerinde çalışan her AI ajanı ve geliştirici için bağlayıcı çalışma sözleşmesidir.
Tek teknik referans: `docs/reference/Emek_Teknik_Mimari_ve_Gelistirme_Blueprint.pdf`
(aranabilir metin çıkarımı: `docs/reference/blueprint-extract.txt`; kararlar: `docs/architecture/`).

## 1. Proje nedir

Emek, ev içi ve bakım hizmetlerinde müşteriler ile bağımsız kadın hizmet sağlayıcılarını buluşturan
**iki taraflı dijital hizmet pazaryeri**dir. Basit bir ilan uygulaması değildir. Beş katman birlikte çalışır:

1. **Marketplace** — kullanıcı, provider, hizmet katalogu, müsaitlik, booking, ödeme, review, dispute.
2. **AI / Decision Engine** — doğal dil talebi → structured request → candidate retrieval → constraints → scoring → optimization → explainability.
3. **Safety & Digital Proof** — hizmet oturumu bazlı telemetri, geofence, anomaly detection, panic flow, before/after kanıt.
4. **Payment Orchestration** — lisanslı ödeme kuruluşu üzerinden şartlı ödeme, settlement, refund, dispute.
5. **Cloud-Native Operations** — event-driven altyapı, analytics, observability, security, CI/CD.

Bağlam: TÜBİTAK 1812 kapsamında Ar-Ge yönü ölçülebilir olmak zorunda. Her algoritma versiyonlanır,
her deney kaydedilir (`docs/research/`).

## 2. Teknoloji stack'i (bağlayıcı)

| Katman           | Teknoloji                                           | Not                                               |
| ---------------- | --------------------------------------------------- | ------------------------------------------------- |
| Mobil            | Flutter + Dart                                      | gerektiğinde Swift/Kotlin native bridge           |
| Web / Admin      | Next.js + TypeScript                                | **Faz 15'e kadar geliştirilmeyecek**              |
| Core backend     | NestJS + TypeScript                                 | tüm transactional business logic                  |
| AI/ML/NLP        | Python + FastAPI                                    | structured extraction, anomaly detection          |
| Optimization     | Python + OR-Tools                                   | assignment, capacity, time windows                |
| Ana veri         | PostgreSQL + PostGIS                                | tek transactional source of truth                 |
| Cache/Lock       | Redis (Memorystore)                                 | cache, rate limit, distributed lock, idempotency  |
| Event bus        | Google Pub/Sub                                      | booking/payment/safety/analytics eventleri        |
| Compute          | Google Cloud Run                                    | stateless container'lar                           |
| Dosya            | Google Cloud Storage                                | before/after, belgeler                            |
| Analytics        | BigQuery                                            | operasyonel/AI/ESG metrikleri                     |
| Auth             | Firebase Authentication                             | OTP + session; backend token doğrular             |
| Push             | Firebase Cloud Messaging                            |                                                   |
| Client integrity | Firebase App Check                                  |                                                   |
| Realtime         | Firestore — **yalnızca** chat/presence/geçici state | ana DB değildir                                   |
| Routing          | Google Maps Route Optimization/Distance Matrix      | Emek'in Ar-Ge motoru değildir, altyapıdır         |
| Identity         | Identity Verification Adapter Layer                 | EKDS/e-ID/NFC/KYC sağlayıcıları adapter arkasında |
| Payment          | Lisanslı ödeme kuruluşu adapter'ı                   | Emek escrow kurmaz                                |
| DevOps           | Docker + GitHub Actions + Terraform                 |                                                   |
| Security         | IAM + Secret Manager + Cloud KMS + RBAC + audit     |                                                   |

Başlangıç mimarisi: **modular monolith (NestJS) + bağımsız AI/optimization servisleri**.
Kubernetes yok, 20-30 mikroservis yok, "her şeyi Python'da yaz" yok.

## 3. Repository yapısı

```
apps/mobile      Flutter (Faz 16)
apps/web         Next.js customer/provider (Faz 15)
apps/admin       Next.js admin/operations (Faz 15)
services/api     NestJS core backend
services/ai      Python + FastAPI (NLP, matching, optimization, anomaly)
packages/api-contracts   OpenAPI/DTO şemaları — backend↔client tek doğruluk kaynağı
packages/shared-types    Paylaşılan TypeScript tipleri
packages/config          Ortak lint/tsconfig/env şema
infra/terraform  GCP altyapısı IaC
infra/docker     Dockerfile'lar + local compose
infra/github-actions  CI/CD workflow'ları
docs/            architecture, api, database, security, research, testing
```

Bu yapıyı değiştirmek gerekirse önce `docs/architecture/adr/` altında ADR yaz, sonra taşı.

## 4. Değişmez mimari kurallar

**Veri**

- PostgreSQL tek transactional source of truth. Firestore'a booking/payment/ledger yazılmaz.
- 1 insan = 1 `users` kaydı. Aynı User altında `customer_profiles` ve `provider_profiles` olabilir.
- Mükerrer hesap engeli **veritabanı UNIQUE constraint'i** ile garanti edilir; sadece uygulama
  kontrolü yetmez. Birincil tekillik `identity_hash` üzerinde, **sağlayıcıdan bağımsız** unique
  index'tir; sağlayıcı kapsamlı `provider_subject_id` tek başına yeterli değildir.
- Ham T.C. kimlik numarası tablolara yayılmaz. KMS'teki non-exportable anahtarla HMAC-SHA256
  `identity_hash`, **adapter sınırının içinde** üretilir. Anahtar rotasyonu yoktur (ADR-0004 §5).
- Idempotency ve event teslim garantisi kalıcı veridir: `idempotency_keys`, `outbox`,
  `processed_events` tabloları PostgreSQL'de ve yan etkiyle aynı transaction'da. Redis hızlı yoldur.
- Dosyalar Cloud Storage'da; PostgreSQL yalnızca metadata + `sha256` + `storage_key` + timestamp tutar.
- Yüksek frekanslı `location_events` süresiz saklanmaz; retention/partition tasarımı baştan yapılır.

**Booking**

- State machine: `REQUESTED → MATCHED → PROVIDER_PENDING → CONFIRMED → PAYMENT_AUTHORIZED → SCHEDULED
→ PROVIDER_ARRIVING → CHECKED_IN → IN_PROGRESS → CHECKED_OUT → CUSTOMER_CONFIRMED → COMPLETED → SETTLED`
- Yan durumlar: `CANCELLED`, `DISPUTED`, `SAFETY_HOLD`.
- Geçişler tek bir merkezî izin tablosundan (transition map) geçer; controller içine gömülmez.
- Her geçiş `booking_status_history`'ye yazılır. Kritik işlemler idempotent.
- Booking **aggregate root**'tur; ödeme durumu onun yanında yaşayan bir projeksiyondur.
- Çakışma engeli `EXCLUDE USING GIST` + **iptal durumlarını dışlayan predikat**; Redis lock
  yalnızca optimizasyondur, doğruluğun kaynağı constraint'tir.
- `CHECK (customer_id <> provider_id)` — kendi kendine booking yasak (metrik manipülasyonu).

**AI**

- LLM/NLP'nin görevi _"müşteri ne istiyor?"_. Provider seçimi **kesinlikle** LLM'e bırakılmaz.
- Seçim zinciri: candidate retrieval → hard constraints → scoring → soft constraints → optimization → explainability.
- Her NLP çıktısında `parser_version` + `parser_confidence`, her matching sonucunda `algorithm_version`
  ve skor bileşenleri saklanır.

**Safety**

- 24 saat sürekli GPS takibi yoktur. Telemetri yalnızca aktif hizmet oturumuna bağlıdır.
- Panic flow deterministic ve anlık; ML kararını beklemez. ML anomaly score destekleyici sinyaldir.
- Risk seviyeleri: `NORMAL`, `WARNING`, `HIGH_RISK`, `EMERGENCY`.
- Telemetri **güvenilmez istemci girdisidir**: sunucu zamanı yetkili, oturum bazlı monoton sıra
  numarası replay'i engeller, mock-location sinyali kayda geçer. "Dijital ispat" tamper-evident'tır.

**Payment**

- Emek escrow/ödeme kuruluşu kurmaz. Lisanslı sağlayıcı adapter arkasında.
- Webhook'lar idempotent: `payment_events.external_event_id` UNIQUE. Aynı event iki kez para serbest bırakmaz.
- PSP'ye giden çağrılar senkron ve kendi idempotency key'ini taşır. **Event'ten para hareketi
  tetiklenmez** (at-least-once teslim → çift yetkilendirme).
- Yetkilendirme süresi dolabilir: `authorization_expires_at` + re-authorization akışı zorunlu.
- **Giden** çağrıların idempotency'si `payment_commands`'ta tutulur: `external_event_id`
  yalnızca **geleni** tekilleştirir. Her işlemin kendi anahtarı olur (ADR-0017 §4).
- Para serbest bırakılmadan booking `SETTLED` olamaz; hizmet tamamlandı diye para otomatik
  çıkmaz (uyuşmazlık penceresi).
- Kanıt dosyaları private storage'da; erişim yalnızca kısa ömürlü signed URL ile ve audit'li.
  `sha256` storage'daki nesneden okunur, yazıldıktan sonra değiştirilemez.

**Security**

- Authentication Firebase Auth; authorization RBAC (`CUSTOMER`, `PROVIDER`, `ADMIN`, `SUPPORT`)
  - ownership, **deny by default**. Yetki kontrolü veri erişim katmanında da uygulanır.
- Secret'lar Secret Manager'da, anahtarlar KMS'te. Repoda hiçbir secret bulunmaz.
- Kritik işlemler `audit_logs`'a işlemle **aynı transaction'da** yazılır; tablo append-only
  (uygulama rolüne UPDATE/DELETE yok) ve hash zinciriyle tamper-evident.
- Zincir tamper-**evident**'tır: doğrulayan bir iş olmadan kopukluk görünmez.
  `AuditVerificationService` artımlı doğrular ve `audit_chain_checkpoints`'a yazar;
  doğrulama tarihsel kayıtları **değiştirmez**, kopukluk bulununca sessizce ilerlemez.
- Guard sırası sabittir: **oran sınırı → App Check → kimlik → rol → kullanıcı kotası**
  (ADR-0022). App Check yetkilendirme değildir; `@SkipAppCheck()` yalnızca istemci
  uygulamasından gelmeyen uçlara (webhook, callback, health) uygulanır.
- İstemci adresi **asla** `request.ip` veya ham `X-Forwarded-For` değildir:
  `resolveClientIp(request, TRUSTED_PROXY_HOP_COUNT)` kullanılır. Express `trust proxy`
  açılmaz (R-53). Oran sınırının iki katmanı da **fail-closed**'dır; panik ucu hiç
  sınırlanmaz (ADR-0008 §3).
- Saklama süresi belgelemekle uygulanmış olmaz: her hassas veri sınıfının **silen bir
  işi** vardır (`data-retention-inventory.md`). Hesap kapatma satırı silmez,
  anonimleştirir — mali ve denetim referansları korunmak zorundadır.
- `identity_hash` anahtarının **rotasyonu yoktur** (ADR-0004 §5). Anahtar değişmek
  zorunda kalırsa izlenecek yol `docs/security/identity-key-migration.md`'dedir ve
  otomatik değildir.
- Kurtarma talebini onaylayan operatör, talebin **tarafı olamaz** (R-36).
- Hukuki doğrulama gerektiren her nokta kodda ve dokümanda `TODO(legal)` ile işaretlenir.

**Event-Driven & Consumers (Faz 9)**

- Belgelenmiş/test edilmiş sözleşme `packages/api-contracts/events/` altındadır (Zod şemaları,
  topic-mapping). **services/api runtime'da bunu import etmez** — paket ham `.ts` olarak
  yayınlandığı için `tsc` build'inde çözülemez (build-tooling kısıtı, bilinçli kabul edilmiş
  risk). Gerçek çalışan topoloji `services/api/src/common/events/event-topology.ts`'dedir; iki
  dosya arasında sürüklenme riski vardır (bkz. `event-driven.md`).
- Tüm consumer'lar `EventConsumer` arayüzünü uygular (`src/common/events/event-consumer.ts`).
- Consumer'lar idempotency yönetiminden (veri tabanında aynı işlemin tekrarlanmaması) kendileri sorumludur; genel event tekilleştirmesi (deduplication) ise runner tarafından `processed_events` ile yapılır.
- Event payload'larında PII verisi yer almaz, yalnızca kimlik referansları (ID'ler) taşınır.
- `EventTransport` üretimde Pub/Sub, geliştirmede `LoggingEventTransport` üzerinden çalışır ve ortam config dosyasında seçilir. `PUBSUB_EMULATOR_HOST` yalnızca emulator gerçekten ayaktayken (`npm run infra:up:events`) ayarlanır — sürekli açık bırakmak publish çağrılarını 10 sn zaman aşımına düşürür.
- Pub/Sub topic'i başına **tek** subscription vardır (`{topic}.core-api`); `PubSubSubscriberService` mesajı `EventConsumerRunner`'a iletir, runner event type'a göre kayıtlı tüm consumer'lara kendi içinde dispatch eder. Consumer başına ayrı subscription açılmaz.
- Olası geçici hatalar `FailureClassification.TRANSIENT`, kalıcı hatalar `PERMANENT` olarak sınıflandırılır (DLQ için).
- Testler runner pipeline'ı `EventConsumerRunner.processEvent` üzerinden (Pub/Sub handler yerine) doğrudan çağırarak sınanmalıdır.

## 5. Çalışma disiplini

**Her faz şu döngüyü izler:**
`inspect → plan → implement (test ile birlikte) → integrate → code review → security review → performance review → docs → git diff review → PHASE COMPLETE`

- Faz sonunda **zorunlu tam code review** yapılır; mümkünse bağımsız review subagent ile.
  Kullanıcı "code review yap" demek zorunda değildir.
- Bulunan sorunlar **aynı faz içinde** düzeltilir.
- Faz tamamlanınca otomatik olarak sonraki faza geçilmez. Kullanıcı "devam" demeden durulur.
- Faz sonu özeti: ne yapıldı, hangi dosyalar değişti, hangi testler geçti, kalan riskler,
  varsayımlar, sonraki faz.

**Kod yazma kuralları**

- Kod yazmadan önce mevcut kodu oku. Bilmediğin dosya/mimari hakkında varsayım yapma.
- Testsiz feature tamamlanmış sayılmaz. Test feature ile birlikte yazılır, sonradan değil.
- Sadece testi geçirmek için hard-code, sahte değer veya özel-case çözüm yazılmaz.
- Gereksiz abstraction, gereksiz dependency, gereksiz teknoloji eklenmez.
- Mevcut çalışan davranış gereksiz refactor ile bozulmaz. Destructive git işlemi yapılmaz.
- Dokümantasyon kodla birlikte güncellenir.

**Yasaklar** — `docs/architecture/initial-assessment.md` §"Anti-hedefler" listesi bağlayıcıdır.

## 6. Faz sırası (özet)

| Faz | Kapsam                                                                                                                                                          | Durum         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 0   | Repository & architecture audit, ADR, konvansiyonlar, test stratejisi, faz planı                                                                                | ✅ tamamlandı |
| 1   | Foundation: monorepo, NestJS, FastAPI, Postgres+PostGIS, Redis, Docker, CI, migration, health                                                                   | ✅ tamamlandı |
| 2   | Core backend: auth, users, roles, RBAC, profiller, service catalog, skills, error handling + **audit (rol ayrımı/hash zinciri), outbox, idempotency altyapısı** | ✅ tamamlandı |
| 3   | Identity: adapter, identity_records, unique identity, recovery, verification levels                                                                             | ✅ tamamlandı |
| 4   | Provider & Booking: availability, PostGIS service areas, booking state machine                                                                                  | ✅ tamamlandı |
| 5   | Payment & Digital Proof: adapter, webhook idempotency, documents, disputes                                                                                      | ✅ tamamlandı |
| 6   | Python AI/NLP: structured extraction, versiyonlama, evaluation dataset                                                                                          |               |
| 7   | Matching & Optimization: retrieval, constraints, scoring, OR-Tools, explainability, benchmark                                                                   |               |
| 8   | Safety: sessions, geofence, telemetry, rules + anomaly, panic flow                                                                                              | ✅ tamamlandı |
| 9   | Event-driven: Pub/Sub, contracts, retries, DLQ, idempotency                                                                                                     | ✅ tamamlandı |
| 10  | Admin/Operations API                                                                                                                                            | ✅ tamamlandı |
| 11  | Analytics: BigQuery pipeline, metrikler                                                                                                                         | ✅ tamamlandı |
| 12  | Security hardening: proxy güveni (R-53), App Check, audit zincir doğrulama, retention, SAST/dependency gate                                                     | ✅ tamamlandı |
| 13  | DevOps: Terraform, Cloud Run, staging/production                                                                                                                |               |
| 14  | Performance & reliability                                                                                                                                       |               |
| 15  | **Web frontend** (bundan önce frontend geliştirilmez)                                                                                                           |               |
| 16  | Flutter mobile                                                                                                                                                  |               |
| 17  | Final E2E + production readiness + TÜBİTAK demo                                                                                                                 |               |

Ayrıntı: `docs/architecture/phase-plan.md`.

## 7. Komutlar

Ayrıntı ve sorun giderme: `docs/architecture/local-development.md`.

```bash
npm install && (cd services/ai && uv sync --all-groups)   # kurulum
cp .env.example .env                                      # yapılandırma
npm run infra:up                                          # Postgres+PostGIS + Redis
npm run infra:up:events                                   # + Pub/Sub emulator (opsiyonel, Faz 2)
npm run migrate:up                                        # şema
npm run dev --workspace=@emek/api                         # core API (watch)
npm run seed:catalog --workspace=@emek/api                # hizmet katalogu referans verisi
npm run contracts:generate --workspace=@emek/api          # OpenAPI sözleşmesini yeniden üret
npm run lint && npm run typecheck && npm test             # hızlı kontrol (altyapı gerekmez)
npm run audit:deps                                        # bağımlılık taraması (CI'da bloklayıcı)
npm run sast                                              # SAST: semgrep (kayıt defteri + Emek kuralları)
npm run test:integration                                  # gerçek Postgres+Redis gerektirir
cd services/ai && uv run pytest                           # AI servisi testleri
cd services/ai && uv run ruff check . && uv run mypy app  # AI lint + typecheck
```

Toolchain: Node 22, TypeScript 6 (`module/moduleResolution: node16`), NestJS 11 (CommonJS —
ADR-0015), Python 3.12 + uv. Build `tsc` iledir; `@nestjs/cli` kullanılmaz.

## 8. Doküman haritası

| Dosya                                         | İçerik                                                         |
| --------------------------------------------- | -------------------------------------------------------------- |
| `docs/architecture/initial-assessment.md`     | Mevcut durum, boşluk analizi, anti-hedefler                    |
| `docs/architecture/adr/`                      | Architecture Decision Record'lar (0001-0022)                   |
| `docs/api/error-codes.md`                     | Business error kodları                                         |
| `docs/architecture/local-development.md`      | Kurulum, komutlar, sorun giderme                               |
| `docs/database/schema.md`                     | Şema, invariant'lar, migration kuralları                       |
| `docs/architecture/phase-plan.md`             | Faz planı, çıktılar, exit kriterleri                           |
| `docs/architecture/coding-conventions.md`     | Kod/commit/naming konvansiyonları                              |
| `docs/architecture/event-catalog.md`          | Event sözlüğü ve şema kuralları                                |
| `docs/architecture/analytics.md`              | BigQuery export pipeline, metrik view'ları, ödeme mutabakatı   |
| `docs/testing/test-strategy.md`               | Test seviyeleri, zorunlu senaryolar, coverage eşiği            |
| `docs/security/data-protection-baseline.md`   | Veri sınıflandırma, KVKK, retention                            |
| `docs/security/rbac-matrix.md`                | Endpoint → rol/sahiplik matrisi                                |
| `docs/security/data-retention-inventory.md`   | Hassas veri envanteri, saklama süreleri, **silen işler**       |
| `docs/security/penetration-test-checklist.md` | Sızma testi koşu listesi ve bugünkü durumu                     |
| `docs/security/identity-key-migration.md`     | Identity HMAC anahtarı göç prosedürü (rotasyon yok)            |
| `docs/research/technical-risks.md`            | Teknik riskler, varsayımlar, hukuki doğrulama gereken noktalar |
| `docs/research/research-metrics.md`           | TÜBİTAK Ar-Ge metrikleri ve deney çerçevesi                    |
