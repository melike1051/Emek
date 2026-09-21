# Test Strategy

## 1. Temel kurallar

1. **Test feature ile birlikte yazılır**, sonradan değil. Testsiz feature tamamlanmış sayılmaz.
2. **Test geçsin diye test silinmez veya zayıflatılmaz.** Başarısız test bir bulgudur; önce kök
   neden bulunur (bkz. systematic debugging), sonra kod düzeltilir.
3. **Hard-coded/özel-case çözüm yasak.** Testi geçirmek için sahte değer döndüren kod yazılmaz.
   Test gerçek ve genel çözümü doğrular.
4. **Integration testler gerçek altyapıya karşı çalışır** — Postgres + PostGIS ve Redis gerçek
   (Testcontainers veya compose). Mock DB ile yazılan test, migration/constraint hatalarını kaçırır.
5. Dış servisler (identity provider, PSP, routing API, LLM) **sözleşme seviyesinde** mock'lanır;
   ayrıca contract test ile gerçek şemaya uyum doğrulanır.
6. Her hata düzeltmesi, o hatayı yakalayan bir regresyon testiyle gelir.

## 2. Test seviyeleri

| Seviye        | Kapsam                                                                                | Araç                       | Ne zaman                             |
| ------------- | ------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------ |
| Unit          | domain kuralları, state transition map, scoring fonksiyonları, DTO validation, parser | Jest/Vitest, pytest        | her PR                               |
| Integration   | Postgres/PostGIS, Redis, migration, repository, outbox, adapter'lar                   | Testcontainers/compose     | her PR                               |
| Contract      | OpenAPI + event şemaları; NestJS ↔ AI servisi; PSP/identity adapter şemaları          | schema validation testleri | her PR                               |
| API           | HTTP seviyesinde auth/RBAC/hata kodları/idempotency                                   | supertest                  | her PR                               |
| Database      | constraint'ler, EXCLUDE, partial unique, partition, retention işi                     | SQL testleri               | ilgili faz + her PR                  |
| Security      | authz bypass, IDOR, rate limit, injection, webhook imza/replay, secret scan, SAST     | otomatik + periyodik       | her PR (tarama), periyodik (pentest) |
| Load          | 100/250/500 eşzamanlı booking; matching/optimization yükü                             | k6/Locust                  | release candidate                    |
| AI evaluation | NLP precision/recall/F1, Recall@K, anomaly recall/FPR                                 | evaluation harness         | model/algoritma sürümünde            |
| E2E           | customer → booking → matching → payment → service → safety → review                   | staging                    | Faz 17 + release                     |
| Chaos/failure | bağımlılık arızaları, duplicate event, retry                                          | staging                    | Faz 14                               |

## 3. Zorunlu senaryolar

Bu senaryolar ilgili faz **tamamlanmış sayılmadan önce** testle kanıtlanır.

| #     | Senaryo                                                                                                               | Beklenen davranış                                                                                                                                       | Faz                                                              |
| ----- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| T-01  | Duplicate identity — aynı kimlik referansıyla eşzamanlı iki kayıt                                                     | tek kayıt; ikinci istek `IDENTITY_ALREADY_REGISTERED`; DB constraint son savunma olarak devreye giriyor                                                 | 3                                                                |
| T-01b | Aynı kişi **farklı identity provider** ile ikinci hesap deniyor                                                       | `identity_hash` unique index çakışma üretir; ikinci hesap açılmaz, recovery'ye yönlendirilir                                                            | 3                                                                |
| T-01c | Hash üretemeyen sağlayıcıyla `IDENTITY_VERIFIED` denemesi                                                             | seviye verilmez; sağlayıcı tekillik gerektiren akışta tek başına kullanılamaz                                                                           | 3                                                                |
| T-02  | Account recovery kötüye kullanımı                                                                                     | ek doğrulama zorunlu, rate limit devrede, her adım audit'li                                                                                             | 3                                                                |
| T-03  | Identity provider erişilemez                                                                                          | akış `PENDING`'de kalır, kullanıcıya anlamlı hata, retry mümkün, yarım kayıt oluşmaz                                                                    | 3                                                                |
| T-04  | Mock provider production config'inde                                                                                  | servis **başlamaz**                                                                                                                                     | 3                                                                |
| T-05  | Concurrent booking — aynı provider/aynı zaman aralığı için N eşzamanlı istek                                          | tek booking oluşur, diğerleri `BOOKING_CONFLICT`; EXCLUDE constraint kanıtlanır                                                                         | 4                                                                |
| T-05b | İptal edilmiş booking'in zaman aralığına yeni booking                                                                 | kabul edilir — EXCLUDE predikatı iptal durumlarını dışlar, slot kalıcı bloklanmaz                                                                       | 4                                                                |
| T-05c | Kullanıcı kendi sağlayıcı profiline booking açıyor                                                                    | `SELF_BOOKING_NOT_ALLOWED`; DB CHECK son savunma                                                                                                        | 4                                                                |
| T-05d | Kullanıcı kendisine review yazıyor                                                                                    | reddedilir; DB CHECK son savunma                                                                                                                        | 5                                                                |
| T-05e | Redis erişilemezken booking oluşturma                                                                                 | akış devam eder, doğruluk EXCLUDE constraint ile korunur (lock yalnızca optimizasyon)                                                                   | 4, 14                                                            |
| T-06  | Geçersiz state geçişi (ör. `REQUESTED → COMPLETED`)                                                                   | `INVALID_STATE_TRANSITION`, history'ye yazılmaz                                                                                                         | 4                                                                |
| T-07  | Aynı komutun tekrarı (idempotency key ile)                                                                            | ikinci çağrı yan etki üretmez, aynı sonucu döner (kayıt DB'de, yan etkiyle aynı transaction'da)                                                         | 4, 5                                                             |
| T-07b | Aynı idempotency key, farklı istek gövdesi                                                                            | `IDEMPOTENCY_KEY_REUSED`; ilk sonuç değişmez                                                                                                            | 4                                                                |
| T-07c | Redis flush sonrası aynı komut tekrarı                                                                                | yine idempotent — kalıcı kayıt DB'de olduğu için çift yan etki oluşmaz                                                                                  | 4, 14                                                            |
| T-08  | Provider unavailable / müsaitlik dışı talep                                                                           | hard constraint eler, `PROVIDER_NOT_AVAILABLE`                                                                                                          | 4, 7                                                             |
| T-09  | Payment webhook duplication — aynı `external_event_id` iki kez                                                        | ikinci event yan etki üretmez, para iki kez serbest bırakılmaz, 200 döner                                                                               | ✅ Faz 5                                                         |
| T-10  | Out-of-order payment event                                                                                            | geri durum geçişi reddedilir, durum monotonluğu korunur                                                                                                 | ✅ Faz 5                                                         |
| T-11  | Dispute/`SAFETY_HOLD` varken release denemesi                                                                         | bloklanır, gerekçe audit'li                                                                                                                             | ✅ Faz 5 (dispute + SAFETY_HOLD); safety tetikleyicisi Faz 8     |
| T-12  | Storage erişimi                                                                                                       | nesneler private; yalnızca kısa ömürlü signed URL ile erişilebilir; imza süresi dolmuş URL reddedilir                                                   | ✅ Faz 5                                                         |
| T-13  | NLP şema ihlali / düşük confidence                                                                                    | çıktı reddedilir veya netleştirme istenir; doğrulanmamış çıktı iş kuralına girmez                                                                       | ✅ Faz 6                                                         |
| T-14  | `raw_text` içinde talimat benzeri içerik (prompt injection)                                                           | veri olarak işlenir, talimat olarak yorumlanmaz; hard constraint'ler etkilenmez                                                                         | ✅ Faz 6                                                         |
| T-15  | AI servisi down                                                                                                       | yapılandırılmış form yolu çalışır; core akış ayakta                                                                                                     | ✅ Faz 6                                                         |
| T-16  | Optimization timeout                                                                                                  | fallback (scoring-only/greedy) devreye girer, sonuç `degraded` işaretli döner                                                                           | 7 ✅                                                             |
| T-17  | Matching determinizmi                                                                                                 | aynı girdi + aynı `algorithm_version` → aynı sıralama                                                                                                   | 7 ✅                                                             |
| T-18  | Hard constraint ihlali yüksek skorla birlikte                                                                         | aday elenir; skor telafi etmez                                                                                                                          | 7 ✅                                                             |
| T-19  | Explainability çıktısı                                                                                                | başka kullanıcının kişisel verisini içermez                                                                                                             | 7 ✅                                                             |
| T-20  | Safety panic — ML, matching ve routing servisleri down                                                                | panic kaydedilir, `EMERGENCY` atanır, alert yayınlanır, p95 hedefi tutar                                                                                | 8                                                                |
| T-21  | Geofence ihlali / rota sapması                                                                                        | ilgili `safety_event` üretilir, risk seviyesi yükselir                                                                                                  | 8                                                                |
| T-22  | Anomaly false positive                                                                                                | `WARNING` seviyesinde doğrulama istenir, otomatik cezai aksiyon alınmaz; FPR ölçülür                                                                    | 8                                                                |
| T-23  | Oturum kapalıyken gelen telemetri                                                                                     | reddedilir (`SAFETY_SESSION_NOT_ACTIVE`), veri yazılmaz                                                                                                 | 8                                                                |
| T-24  | Location retention                                                                                                    | süresi geçen yüksek frekanslı kayıtlar gerçekten silinir/agregatlanır                                                                                   | 8, 12                                                            |
| T-25  | Pub/Sub duplicate event                                                                                               | consumer idempotent, yan etki tek                                                                                                                       | 9                                                                |
| T-26  | Outbox — commit edildi ama publish edilmedi                                                                           | publisher yeniden dener, event kaybolmaz                                                                                                                | 9                                                                |
| T-27  | Redis unavailable                                                                                                     | cache yolu degrade eder; rate limit ve distributed lock **fail-closed** davranır (güvenlik kritik yollar açılmaz)                                       | 1, 14                                                            |
| T-28  | Database connection kaybı/pool tükenmesi                                                                              | istekler anlamlı hata verir, kısmi yazma oluşmaz, health endpoint durumu bildirir                                                                       | 1, 14                                                            |
| T-29  | Routing/external API hatası                                                                                           | haversine fallback, sonuç işaretli, akış devam eder                                                                                                     | 7, 14                                                            |
| T-30  | Yetkisiz erişim / IDOR                                                                                                | başka kullanıcının booking/document/safety verisine erişim 403/404; SUPPORT yıkıcı aksiyon yapamaz                                                      | 2, 10, 12                                                        |
| T-31  | Hata mesajı sızıntısı                                                                                                 | ham exception/stack/SQL hatası client'a dönmez                                                                                                          | 2                                                                |
| T-32  | Log PII kontrolü                                                                                                      | token, OTP, kart verisi, ham kimlik bilgisi loglarda yok                                                                                                | 2, 12                                                            |
| T-33  | **Sahte/replay/geri tarihli telemetri** — mock-location, tekrar gönderilen paket, ileri/geri kaydırılmış `capturedAt` | `TELEMETRY_REJECTED`; sunucu zamanı yetkili, sıra numarası monoton, mock-location sinyali kayda geçer ve risk skorunu etkiler                           | 8                                                                |
| T-34  | Ödeme yetkilendirme süresi dolmuş, release deneniyor                                                                  | `PAYMENT_AUTHORIZATION_EXPIRED`; re-authorization akışı tetiklenir, çift yetkilendirme oluşmaz                                                          | ✅ Faz 5                                                         |
| T-35  | `audit_logs` UPDATE/DELETE/TRUNCATE denemesi                                                                          | trigger reddeder (role bağlı olmayan koruma) + `PUBLIC`'ten yetki alınmış. **Kısmi:** uygulamaya ayrı DB kullanıcısı Faz 13'te (ADR-0013 uygulama notu) | 2                                                                |
| T-36  | Audit hash zinciri kopukluğu                                                                                          | doğrulama işi kopukluğu tespit eder ve alarm üretir                                                                                                     | 12                                                               |
| T-37  | Yetkilendirme guard'ı olmayan endpoint                                                                                | otomatik route taraması böyle bir endpoint bulursa test kırılır (deny by default)                                                                       | 2                                                                |
| T-38  | Event'ten para hareketi tetiklenmesi                                                                                  | duplicate `ProviderAccepted`/`ServiceCompleted` teslimi PSP'ye ikinci `authorize`/`capture` göndermez                                                   | ✅ Faz 5 (giden idempotency); Pub/Sub teslimiyle uçtan uca Faz 9 |
| T-39  | Outbox'ta bekleyen event, publish başarısız                                                                           | publisher yeniden dener; event kaybolmaz, çift işlenmez                                                                                                 | 2, 9                                                             |

## 4. Coverage ve kalite kapıları

**Birincil kapı zorunlu senaryolardır**, kapsam yüzdesi değil. Yukarıdaki tablo, kapsam
rakamından bağımsız olarak karşılanmak zorundadır; asıl değerli artefakt bu listedir.

Kapsam bir **sinyaldir**, hedef değil:

- Faz 1-3'te sabit kapsam eşiği uygulanmaz — bu dönemde eşik, testin değerini değil miktarını ödüllendirir.
- Faz 4'ten itibaren domain/business logic modüllerinde (state machine, scoring, constraint,
  payment, identity, safety kuralları) kapsamın **düşmesi** CI'ı kırar (baseline'a göre regresyon
  kontrolü). Mutlak eşik gerekiyorsa ölçülen gerçek değere göre Faz 4'te belirlenir, şimdi uydurulmaz.
- Controller/adapter/infrastructure için kapsam eşiği yok; bu katmanlarda API ve contract testleri esas.
- CI kapıları (Faz 1'den itibaren artımlı): lint → typecheck → unit → integration → contract →
  security scan (dependency + secret + SAST) → build.
- Flaky test tolere edilmez: ya düzeltilir ya da nedeni yazılıp quarantine'e alınır ve takip edilir.

## 5. Test verisi

- Gerçek kişisel veri test ortamında kullanılmaz. Fixture/factory ile sentetik veri üretilir.
- AI evaluation dataset'i anonimleştirilmiş/sentetiktir ve versiyonlanır (`docs/research/experiments/`).
- Testler birbirinden izole: her test kendi verisini kurar, paylaşılan global state'e dayanmaz.

## Integration test koşum disiplini (Faz 6)

- Uygulama sunucusu **suite başına bir kez** dinlemeye alınır (`createTestApp`).
  supertest'in her istekte geçici port açıp kapatması, paket büyüdükçe efemeral port
  baskısı yaratıp rastgele suite'lerde "socket hang up" üretiyordu.
- Arka planda çalışan bileşenlerin (outbox publisher) sonucu, **elle tetiklenen çağrının
  dönüş değerine** değil kalıcı duruma bakılarak ölçülür; aksi halde test, yarışın hangi
  tarafının kazandığını ölçer.
- Testler `NODE_ENV=test` ile çalışır; `.env` geliştirme içindir ve üzerine yazılır.
