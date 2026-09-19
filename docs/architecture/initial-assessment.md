# Initial Assessment — Faz 0

Tarih: 2026-09-20
Kaynak: `Emek_Teknik_Mimari_ve_Gelistirme_Blueprint.pdf` (23 sayfa, 35 bölüm) + proje talimatları.

## 1. Mevcut repository durumu

Repository **greenfield**. Denetim öncesi tek içerik:

```
/Users/meltem/Desktop/Emek
└── .claude/settings.local.json   (Claude Code plugin ayarları)
```

- Git repository başlatılmamıştı (Faz 0'da `git init` yapıldı).
- Hiçbir uygulama kodu, dependency manifesti (`package.json`, `pyproject.toml`, `pubspec.yaml`),
  migration, Dockerfile, CI workflow veya Terraform modülü yok.
- Dolayısıyla **legacy kod riski, migration borcu veya geriye dönük uyumluluk yükümlülüğü yok.**
  Blueprint doğrudan uygulanabilir; "mevcut kodu koru" kısıtı bu aşamada boş kümedir.

Sonuç: Blueprint ile mevcut kod arasındaki fark = blueprint'in tamamı. Klasik migration planı
yerine **bağımlılık sıralı inşa planı** gerekir (bkz. `phase-plan.md`).

## 2. Yerel toolchain denetimi

| Araç | Bulunan | Gereken | Durum |
|---|---|---|---|
| Node.js | v22.23.2 | ≥ 20 LTS (NestJS 11, Next.js 15) | ✅ |
| npm | 10.9.8 | workspaces destekli | ✅ |
| Python | 3.9.6 (sistem) | **3.11+** (FastAPI + modern tip sistemi, OR-Tools) | ⚠️ yükseltme gerekli |
| Docker | 29.2.0 | compose v2 | ✅ |
| git | 2.54.0 | — | ✅ |
| Flutter SDK | yok | Faz 16 | ⏳ Faz 16'ya kadar gerekmez |
| gcloud CLI | doğrulanmadı | Faz 13 | ⏳ |
| Terraform | doğrulanmadı | Faz 13 | ⏳ |

**Aksiyon (Faz 1):** Python 3.9 sistem yorumlayıcısı kullanılmayacak. `services/ai` için `uv` ile
pinlenmiş Python 3.12 toolchain kurulacak; CI ve Docker image aynı sürüme pinlenecek. Yerel sürüm
farkı "benim makinemde çalışıyor" sınıfı hataların birincil kaynağıdır.

## 3. Blueprint'ten çıkarılan bağlayıcı kararlar

Aşağıdaki kararlar tartışmaya açık değildir; her biri ADR olarak kayıtlıdır (`adr/`).

1. **Modular monolith + ayrık AI servisleri** — mikroservis patlaması ve Kubernetes başlangıçta yok. (ADR-0001)
2. **Core backend NestJS/TypeScript, AI/optimization Python** — dil sınırı domain sınırıyla örtüşür. (ADR-0002)
3. **PostgreSQL + PostGIS tek transactional source of truth**; Firestore yalnızca yardımcı realtime. (ADR-0003)
4. **1 insan = 1 User**, çok rollü profil; mükerrer kimlik DB UNIQUE ile engellenir. (ADR-0004)
5. **Identity Verification Adapter Layer** — EKDS/e-ID/KYC sağlayıcısı soyutlanır, core değişmez. (ADR-0005)
6. **Booking state machine merkezî transition map + history** ile yönetilir. (ADR-0006)
7. **LLM karar vermez**; provider seçimi deterministik retrieval + constraints + optimization ile yapılır. (ADR-0007)
8. **Safety = hizmet oturumu bazlı telemetri**, rules + ML hibriti, deterministik panic flow. (ADR-0008)
9. **Ödeme lisanslı kuruluş üzerinden**; idempotent webhook, Emek escrow kurmaz. (ADR-0009)
10. **Event-driven yan akışlar Pub/Sub ile**; core request path'i bloklanmaz. (ADR-0010)
11. **Frontend Faz 15'ten önce geliştirilmez**; API contract frontend'i şekillendirir, tersi değil. (ADR-0011)
12. **Ar-Ge ölçülebilirliği veri modelinin parçası** — parser/algorithm/model version kolonları zorunlu. (ADR-0012)
13. **Deny-by-default yetkilendirme + tespit edilebilir (tamper-evident) audit izi.** (ADR-0013)

## 4. Boşluk analizi — blueprint vs. repo

| Alan | Blueprint gereksinimi | Mevcut | Faz |
|---|---|---|---|
| Monorepo iskeleti | apps/services/packages/infra/docs | ✅ Faz 0'da kuruldu (boş) | 0 |
| Workspace/build sistemi | npm workspaces + uv | yok | 1 |
| NestJS core API | 18 domain modülü | yok | 1-2 |
| FastAPI AI servisi | NLP/matching/optimization/anomaly | yok | 1, 6-8 |
| PostgreSQL şeması | ~25 tablo + PostGIS + enum'lar | yok (DDL blueprint'te taslak) | 1-8 kademeli |
| Migration altyapısı | versiyonlu, geri alınabilir | yok | 1 |
| Redis | cache/lock/idempotency/rate limit | yok | 1 |
| Auth + RBAC | Firebase Auth doğrulama + 4 rol | yok | 2 |
| Identity adapter | provider-agnostic + mock | yok | 3 |
| Booking state machine | 12 ana + 3 yan durum | yok | 4 |
| Payment adapter | intent/hold/settle/refund/webhook | yok | 5 |
| AI pipeline | NLP → retrieval → constraints → scoring → optimization | yok | 6-7 |
| Safety engine | session/geofence/telemetry/panic/anomaly | yok | 8 |
| Pub/Sub | event contracts + DLQ + idempotency | yok | 9 |
| Admin/Ops API | verification queue, ops dashboard verileri | yok | 10 |
| Analytics | BigQuery pipeline, ESG metrikleri | yok | 11 |
| Terraform/CI/CD | GCP IaC + 3 ortam + pipeline | yok | 1 (temel CI), 13 |
| Test altyapısı | unit/integration/contract/E2E/load/security | yok | 1'den itibaren her fazda |

## 5. Blueprint'te tespit edilen açık noktalar ve düzeltmeler

Blueprint'in taslak DDL'i başlangıç noktasıdır; şu noktalar uygulanırken **düzeltilecek**:

| # | Blueprint'teki durum | Sorun | Karar |
|---|---|---|---|
| G-1 | `bookings.provider_id NOT NULL` | `REQUESTED` durumunda provider henüz yok | `provider_id` nullable, `MATCHED`+ durumlarında CHECK ile zorunlu — veya booking yalnızca eşleşme sonrası oluşur. Faz 4'te ADR ile netleşecek (R-14). |
| G-2 | `bookings.status VARCHAR(40)` | serbest metin state — geçersiz durum yazılabilir | PostgreSQL ENUM veya `booking_status` referans tablosu + FK |
| G-3 | Booking çakışma kontrolü yok | eşzamanlı rezervasyon çifte atama üretir | `tstzrange` + `EXCLUDE USING GIST`, **iptal durumlarını dışlayan predikatla** + Redis lock (optimizasyon). Predikat olmadan iptal edilen slot kalıcı bloklanır (R-27) |
| G-4 | `location_events` düz tablo, istemci zamanına güveniyor | yüksek hacim + retention yok + mock-location/replay ile kandırılabilir | partition + retention + agregasyon; `server_received_at`, monoton sıra numarası, mock-location sinyali (Faz 8, R-26) |
| G-5 | `identity_records` tekilliği sağlayıcı kapsamlı | aynı kişi farklı sağlayıcıyla ikinci hesap açabilir; `identity_hash` UNIQUE ama NULL'a izinli | birincil tekillik `identity_hash` üzerinde **sağlayıcıdan bağımsız** partial unique index; hash zorunlu ve adapter içinde KMS HMAC ile üretilir (ADR-0004, R-25) |
| G-6 | `payments.booking_id UNIQUE`, yetkilendirme süresi yok | kısmi iade/çoklu intent kilitlenir; hold hizmet gününden önce sona erebilir | Faz 5'te `payment_intents` ayrımı değerlendirilir; `authorization_expires_at` + re-authorization eklenir (R-29) |
| G-7 | `audit_logs` normal tablo | değiştirilebilir; Faz 2'den yazılıyor ama koruma Faz 12'de | rol ayrımı **Faz 2'ye alındı** + hash zinciri + retention-locked export (ADR-0013, R-31) |
| G-8 | `reviews` çift yönlü, görünürlük kuralı ve kendi kendine review engeli yok | karşılıklı intikam; `UNIQUE (booking_id, reviewer_id, reviewee_id)` self-review'u engellemez | double-blind yayınlama penceresi + `CHECK (reviewer_id <> reviewee_id)` (Faz 5/10, R-28) |
| G-9 | `booking_match_results` "öneri" olarak geçiyor | Ar-Ge ölçümü bu tabloya bağlı | **zorunlu** tablo; Faz 7'de şemaya girer |
| G-10 | `provider_service_areas.area GEOGRAPHY(Polygon)` | çok parçalı bölge desteklenmez | `MULTIPOLYGON` + geçerlilik kontrolü |
| G-11 | Kendi kendine booking engeli yok | tek User/iki profil modeli GMV/review/ESG manipülasyonuna açık | `CHECK (customer_id <> provider_id)` (Faz 4, R-28) |
| G-12 | Idempotency ve outbox altyapısı şemada yok | ödeme/state geçişi çift işlenebilir, event sessizce kaybolabilir | `idempotency_keys`, `outbox`, `processed_events` tabloları **Faz 2'de** (ADR-0003, ADR-0010, R-32, R-33) |

## 6. Anti-hedefler (bağlayıcı yasaklar)

Aşağıdakiler blueprint ve proje talimatlarında açıkça yasaklanmıştır:

- Her şeyi Python ile yazmak; core business logic'i Python'a taşımak.
- Her şeyi Firebase'e taşımak; Firestore'u primary transactional/financial DB yapmak.
- İlk sürümde 20-30 mikroservis; Kubernetes'i "modern görünmek için" eklemek.
- Kendi escrow/ödeme kuruluşunu yazmak.
- LLM'e doğrudan provider seçtirmek; AI'a tek başına emergency kararı vermek.
- 24 saat sürekli GPS tracking.
- Ham T.C. kimlik numarasını tablolara yaymak; gereksiz hassas veri saklamak.
- Testleri silerek/değiştirerek problemi gizlemek; sadece testi geçiren özel-case kod; hard-code.
- Sadece demo için çalışan fake backend.
- Frontend'i backend'den önce ana geliştirme alanı yapmak.
- Gereksiz abstraction, dependency ve teknoloji.
- EKDS/resmî servis erişiminin hazır ve garanti olduğunu varsaymak.

## 7. Faz 0 çıktıları

| Dosya | Amaç |
|---|---|
| `CLAUDE.md` | Çalışma sözleşmesi, stack, değişmez kurallar, faz durumu |
| `README.md` | Proje girişi ve doküman haritası |
| `.gitignore` | Secret/build/artifact sızıntısı engeli |
| Monorepo iskeleti | apps/, services/, packages/, infra/, docs/ |
| `docs/architecture/adr/0001-0013` | 13 bağlayıcı mimari karar |
| `docs/api/error-codes.md` | Business error kodları sözlüğü |
| `docs/reference/` | Blueprint PDF + metin çıkarımı (doğrulanabilir tek referans) |
| `docs/architecture/phase-plan.md` | Faz çıktıları + exit kriterleri |
| `docs/architecture/coding-conventions.md` | Kod, isimlendirme, commit, hata kodu konvansiyonları |
| `docs/architecture/event-catalog.md` | Event sözlüğü ve şema kuralları |
| `docs/testing/test-strategy.md` | Test seviyeleri, zorunlu senaryolar, coverage kapıları |
| `docs/security/data-protection-baseline.md` | Veri sınıflandırma, KVKK, retention, erişim |
| `docs/research/technical-risks.md` | Riskler, varsayımlar, hukuki doğrulama noktaları |
| `docs/research/research-metrics.md` | Ar-Ge metrikleri ve deney çerçevesi |

Faz 0'da bilinçli olarak **uygulama kodu yazılmadı**.

## 8. Faz 0 code review bulguları ve çözümleri

Faz sonu zorunlu review bağımsız bir architecture-review agent'ıyla yapıldı (blueprint'i ve tüm
Faz 0 çıktılarını sıfırdan okuyarak). Bulgular aynı faz içinde kapatıldı:

| Bulgu | Çözüm |
|---|---|
| Tekillik sağlayıcı kapsamlı — aynı kişi farklı KYC sağlayıcısıyla ikinci hesap açabilir | ADR-0004 §2: birincil unique index `identity_hash` üzerinde, sağlayıcıdan bağımsız; hash zorunlu (§3) |
| HMAC anahtar "rotasyonu" teknik olarak imkânsız (ham girdi saklanmıyor) ama plan rotasyon öngörüyordu | ADR-0004 §5: non-exportable anahtar, rotasyon kapalı, zorunlu değişimde re-verification migration |
| `identity_hash`'in nerede üretildiği tanımsızdı | ADR-0005: adapter sınırının içinde, KMS HMAC ile; `capabilities()` hash yeteneğini bildirir |
| Outbox Faz 9'da, ama Faz 3/5/8 garantisi ona bağlı | ADR-0010 §2 + faz planı: outbox/publisher/`processed_events` **Faz 2**'ye alındı |
| `ProviderAccepted` event'inden ödeme yetkilendirme tetikleniyordu (at-least-once → çift authorize) | Event kataloğu + ADR-0009 §5-6: PSP çağrıları senkron, outbound idempotency key; consumer listesi düzeltildi |
| Idempotency yalnızca Redis'te, ama "Redis kaybı veri kaybı değil" deniyordu | ADR-0003: `idempotency_keys` tablosu DB'de, yan etkiyle aynı transaction'da; Redis hızlı yol |
| Redis lock fail-closed kuralı, DB constraint'in yeterli olduğu booking yolunu gereksiz blokluyordu | ADR-0003: cache degrade / rate limit fail-closed / lock optimizasyon ayrımı netleşti |
| `EXCLUDE USING GIST` predikatsız — iptal edilen booking slotu kalıcı bloklar | ADR-0006 §8: iptal durumlarını dışlayan predikat + T-05b |
| Kendi kendine booking ve kendi kendine review engeli yok | ADR-0006 §9 + ADR-0004 §9: `CHECK` invariant'ları + T-05c, T-05d |
| Tüm safety telemetrisi ve "dijital ispat" istemci verisine güveniyordu | ADR-0008 §7-8: sunucu zamanı yetkili, monoton sıra no, mock-location sinyali, tamper-evident dili + T-33 |
| `audit_logs` Faz 2'den yazılıyor ama koruma Faz 12'de | ADR-0013 (yeni): rol ayrımı Faz 2, hash zinciri, retention-locked export + T-35, T-36 |
| RBAC/authz ve audit bütünlüğü için ADR yoktu | ADR-0013 yazıldı: deny by default, ownership, veri katmanı kapsamı, rol yetenek matrisi |
| Ödeme yetkilendirme süresi dolma senaryosu tanımsız | ADR-0009 §4: `authorization_expires_at`, re-authorization, `PAYMENT_AUTHORIZATION_EXPIRED` + T-34 |
| Event tipi başına topic → tek consumer yokken 15 topic (aşırı mühendislik) | ADR-0010 §8: domain başına topic, event tipi attribute'ta; ihtiyaç ölçülünce bölünür |
| Faz 1'den itibaren %85 kapsam eşiği gerekçesiz | Test stratejisi §4: birincil kapı zorunlu senaryolar; kapsam sinyal, regresyon kontrolü Faz 4'ten |
| Blueprint "tek referans" deniyor ama repoda yok | `docs/reference/` altına PDF + metin çıkarımı eklendi |
| `docs/api/error-codes.md` ve `docs/research/experiments/` referansları boştaydı | ikisi de oluşturuldu |
| `.gitignore` `.terraform.lock.hcl`'i yoksayıyordu (tekrar üretilebilirliği bozar) | satır kaldırıldı |

**Kabul edilmeyen tek öneri:** Faz 10'da salt-okunur iç ops görünümü üretmek. Gerekçesi geçerli
(blueprint §17/§26 demo anlatısı admin ekranına dayanıyor) ancak faz sırası kullanıcının açık
talimatıdır; ADR-0011'e "bilinen raporlama riski" + onay bekleyen seçenek olarak yazıldı.

## 9. Sonraki faz

**Faz 1 — Foundation.** Exit kriterleri `phase-plan.md` §Faz 1'de. Özet: `docker compose up` ile
Postgres+PostGIS+Redis ayağa kalkar, NestJS ve FastAPI health endpoint'leri yeşil döner,
ilk migration çalışır ve geri alınır, CI lint+test+build'i PR'da zorunlu kılar.
