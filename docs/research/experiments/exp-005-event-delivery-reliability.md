# EXP-005: Event Delivery Reliability

- Tarih: 2026-09-22
- Faz: 9

## Hipotez

Outbox deseni ve idempotent consumer birleşimi, Emek sistemindeki yan akışların güvenilirliğini (at-least-once delivery) garanti eder. Sistemde yaşanabilecek ağ kesintileri, sunucu çökmeleri veya veritabanı yavaşlamaları gibi durumlarda dahi kritik event'ler (örn. `BookingCreated`, `PaymentAuthorized`) sessizce kaybolmamalı veya consumer tarafında birden çok kez hatalı şekilde işlenmemelidir.

## Yöntem

Bu deney istatistiksel bir ölçüm (ör. FPR, gecikme dağılımı) değildir: teslim güvenilirliği
**deterministik davranış** iddiasıdır (mesaj kaybolmaz, çift işlenmez) — bu yüzden "başarı oranı"
yerine, her senaryonun **gerçek koddan geçerek** ve **tekrar üretilebilir** biçimde doğrulandığı
otomatik test paketleri referans alınır:

- Birim: `services/api/src/common/events/event-consumer-runner.spec.ts` (14 test) — `PubSub`/DB
  mock'lanır, yalnızca pipeline karar mantığı (validate → dedup → dispatch → classify → ack/nack)
  izole test edilir.
- Entegrasyon: `services/api/test/events.integration.spec.ts` (gerçek Postgres) — `processed_events`,
  `dead_letter_events`, `notification_jobs`, `analytics_events` tablolarına karşı uçtan uca.

## Senaryolar ve doğrulama

1. **Normal akış:** Geçerli bir event → ilgili consumer'lar çalışır, `processed_events`'e yazılır.
   Doğrulama: `events.integration.spec.ts` — "geçerli BookingCreated olayı" testi.
2. **Duplicate detection:** Aynı `eventId` ikinci kez (sıralı ve **eşzamanlı**) gönderilir. Beklenen:
   ikinci teslim `processed_events`'in `PRIMARY KEY (consumer, event_id)`'i üzerinden `DUPLICATE`
   olarak işaretlenir, iş etkisi ikinci kez üretilmez.
   Doğrulama: `events.integration.spec.ts` — "aynı event ikinci kez", "concurrent duplicate delivery".
3. **Transient failure:** Consumer `handle()` bilinmeyen/geçici sınıflı bir hata fırlatır (ör.
   `ECONNREFUSED`, sınıflandırılamayan `Error`). Beklenen: `rollbackDeduplication` ile
   `processed_events` kaydı geri alınır, runner `NACK` döner (Pub/Sub yeniden dener); event
   **DLQ'ya yazılmaz**.
   Doğrulama: `event-consumer-runner.spec.ts` — "TRANSIENT hata dönerse NACK döner",
   "consumer hata fırlatırsa yakalanır ve TRANSIENT olarak sınıflandırılır".
4. **Permanent failure (DLQ):** Consumer `handle()` `FailureClassification.PERMANENT` bildirir
   (ör. `TypeError`, şema ihlali). Beklenen: `dead_letter_events`'e yazılır, runner `ACK` döner
   (yeniden denenmez). **Not:** bozuk **envelope** (eksik zorunlu alan) ayrı bir yoldur —
   `validateEnvelope()` tarafından pipeline'a hiç girmeden `ACK` ile atılır ve DLQ'ya yazılmaz
   (bkz. `event-consumer-runner.ts`); yalnızca **consumer'ın kendi bildirdiği** kalıcı hatalar
   DLQ'ya gider.
   Doğrulama: `event-consumer-runner.spec.ts` — "PERMANENT hata dönerse DLQ kaydı oluşturulur",
   "TypeError fırlatırsa PERMANENT olarak sınıflandırılır"; `events.integration.spec.ts` — "DLQ
   kaydı oluşturulur ve unresolvedCount artar".

## Sonuçlar

- Yukarıdaki 4 senaryonun tamamı ilgili test dosyalarında **yeşil** ve deterministik (CI'da her
  çalıştırmada aynı sonuç — rastgelelik/zamanlama'ya bağlı değil, tamamı doğrudan
  `processEvent()`/`markProcessed()` çağrılarıyla sürülüyor).
- Consumer dedup işaretlemesi ile `handle()` çağrısı **aynı transaction'da değildir** — süreç tam
  arada çökerse event kalıcı olarak "işlenmiş" görünür ama hiç işlenmemiş olur. Bu **ölçülmedi**
  (kod incelemesiyle tespit edildi); kabul edilmiş dar bir risk → R-75
  (`docs/research/technical-risks.md`).
- Pull-based Pub/Sub teslimi (`PubSubSubscriberService`) gerçek bir Pub/Sub/emulator karşısında
  **uçtan uca** test edilmedi (yalnızca mock'lanmış `PubSub` client ile birim test edildi —
  `pubsub-subscriber.service.spec.ts`); emulator profiliyle (`npm run infra:up:events`) manuel
  doğrulama Faz 13 DevOps çalışmasına bırakıldı.

## Kararlar

- **At-least-once + idempotent consumer tasarımı doğrulandı:** dedup ve DLQ mekanizmaları, iddia
  edilen "mesaj kaybolmaz veya çift işlenmez" garantisini kod seviyesinde karşılıyor.
- **Consumer sorumluluğu:** runner tekilleştirme yapsa da, `handle()` içindeki iş katmanı yan
  etkilerinin de (ör. DB unique constraint) idempotent olması gerekir — bu, ikinci savunma
  hattıdır ve mevcut consumer'larda (`notification_jobs`/`analytics_events` UNIQUE) sağlanmıştır.
- **Kalıcı hata yönetimi:** sınıflandırma (`failure-classifier.ts`) sistem genişledikçe
  güncellenecek; yeni hata türleri eklendiğinde ilgili birim testleri de eklenir.
