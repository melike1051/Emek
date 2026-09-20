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

## Faz 3 — Identity

**Kapsam:** `identity_records`, `verification_attempts` + constraint'ler (ADR-0004: `identity_hash`
üzerinde sağlayıcıdan bağımsız partial unique index dahil); `IdentityVerificationProvider` port +
`MockIdentityProvider`; verification session API (`POST /verification/session`,
`GET /verification/session/:id`, imzalı `POST /verification/callback`, `GET /verification/status`);
**adapter içinde** KMS HMAC ile `identity_hash` üretimi (`hash_key_version` teşhis amaçlı,
rotasyon kapalı); unique identity enforcement; account recovery akışı; verification level geçişleri;
audit.

**Exit:** eşzamanlı çift kimlik kaydı denemesi DB constraint'iyle engellendi (T-01);
farklı sağlayıcıyla ikinci hesap denemesi engellendi (T-01b); hash üretemeyen sağlayıcı
`IDENTITY_VERIFIED` veremiyor (T-01c); recovery akışı ek doğrulama ve rate limit ile korunuyor (T-02);
mock provider production config'inde seçilirse servis başlamıyor (T-04); ham kimlik alanı hiçbir
tabloda ve logda yok; callback replay reddi test edildi.

---

## Faz 4 — Provider & Booking

**Kapsam:** `addresses` + PostGIS `location`; `provider_service_areas` (MULTIPOLYGON + GIST);
`availability`, `availability_exceptions` (recurrence); `booking_requests`; `bookings` +
`booking_status_history`; merkezî state machine (ADR-0006); çakışma engeli
(`EXCLUDE USING GIST` — **iptal durumlarını dışlayan predikatla** — + Redis lock);
DB invariant'ları (`customer_id <> provider_id`, zaman/fiyat CHECK'leri, duruma bağlı `provider_id`);
booking API'leri (create/confirm/cancel/check-in/check-out/complete).
**R-14 kararı bu fazda ADR ile kapanır** (`provider_id` nullable + duruma bağlı zorunluluk).

**Exit:** geçersiz state geçişi reddediliyor (T-06); eşzamanlı çakışan booking tek kayıt üretiyor
(T-05); iptal edilen slot yeniden rezerve edilebiliyor (T-05b); kendi kendine booking reddediliyor
(T-05c); Redis yokken booking doğruluğu korunuyor (T-05e); idempotent tekrar çağrı yan etki
üretmiyor (T-07, T-07b); PostGIS sorguları indeks kullanıyor (`EXPLAIN` ile doğrulandı);
tüm geçişler history'de.

---

## Faz 5 — Payment & Digital Proof

**Kapsam:** `PaymentProvider` port + sandbox adapter (outbound idempotency key ile); `payments`
(+ `authorization_expires_at`), `payment_events`; ödeme state machine (booking aggregate root,
payment projeksiyon — ADR-0009); re-authorization akışı; imzalı + idempotent webhook handler;
`disputes`; `documents` + Cloud Storage signed URL upload/download; before/after kanıt akışı ve
`sha256` bütünlük kaydı; booking evidence ilişkisi; `reviews` CHECK invariant'ları.
`payments.booking_id UNIQUE` yeterliliği değerlendirilir; `payment_intents` ayrımı gerekirse ADR yazılır.

**Exit:** duplicate webhook ikinci kez yan etki üretmiyor (T-09); out-of-order event reddi (T-10);
dispute/SAFETY_HOLD varken release bloklanıyor (T-11); yetkilendirme süresi dolmuşken release
denemesi doğru hata veriyor ve re-authorization çalışıyor (T-34); event'ten para hareketi
tetiklenmiyor (T-38); storage nesneleri private, yalnızca kısa ömürlü signed URL ile erişilebiliyor
(T-12); kart verisi hiçbir yerde tutulmuyor.

---

## Faz 6 — Python AI / NLP

**Kapsam:** FastAPI AI servisi; Türkçe serbest metin → structured request; Pydantic şema
doğrulama + confidence; `parser_version`; kural tabanlı baseline parser; evaluation dataset
yapısı (sentetik/anonim) + harness; NLP metrikleri (precision/recall/F1, slot F1); düşük
confidence'ta netleştirme/form fallback; prompt injection ve zararlı girdi testleri.

**Exit:** baseline vs proposed karşılaştırması ölçüldü ve `docs/research/experiments/` altında
raporlandı; şemaya uymayan model çıktısı reddediliyor; AI servisi down iken core akış form
yoluyla çalışıyor (test).

---

## Faz 7 — Matching & Optimization

**Kapsam:** candidate retrieval (SQL/PostGIS); hard constraints; versiyonlu ağırlıklarla scoring;
OR-Tools optimization (assignment + time windows + capacity + travel); routing sağlayıcı
abstraction (gerçek ETA opsiyonel, fallback haversine); ranking; explainability üretimi;
`booking_match_results`; benchmark harness (Recall@K, acceptance rate, latency, travel/distance
reduction, constraint violation, runtime).

**Exit:** aynı girdi + aynı `algorithm_version` → aynı sonuç (determinizm testi); optimization
timeout'unda fallback devrede ve sonuç işaretli; hard constraint ihlali hiçbir skorla geçmiyor;
explainability kullanıcı verisi sızdırmıyor; benchmark sonuçları raporlandı.

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
