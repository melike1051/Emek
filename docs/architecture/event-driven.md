# Event-Driven Architecture (Faz 9)

Emek platformu, ana işlem yolunun (request path) gecikmesini (latency) korumak ve hata izolasyonu sağlamak amacıyla asenkron yan akışlar için event-driven bir mimari kullanır (ADR-0010).

## Genel Bakış

Sistem aşağıdaki ana bileşenlerden oluşur:

1. **Producer (Outbox Pattern):** Event'ler, domain değişikliğiyle aynı veritabanı transaction'ı içinde `outbox` tablosuna yazılır.
2. **Transport Katmanı:** Outbox publisher, event'leri okur ve seçili transport katmanı üzerinden iletir (yerel geliştirme için `LoggingEventTransport`, üretim için `PubSubEventTransport`).
3. **Consumer Runner Pipeline:** İletilen event'leri alır, doğrulama, tekilleştirme ve sınıflandırma işlemlerinden sonra hedeflenen domain consumer'larına dağıtır.

### Zarf (Envelope) ve Taksonomi

Tüm event'ler standart bir zarf (envelope) kullanır. `packages/api-contracts/events/envelope.ts` dosyasında tanımlanan zarf yapısı şunları içerir:

- `eventId`: Consumer idempotency için kullanılan eşsiz anahtar.
- `eventType`: Event'in türü (örn. `BookingCreated`).
- `eventVersion`: Şema evrimi için.
- `occurredAt`: Olay zamanı.
- `aggregateType` / `aggregateId`: Olayın ait olduğu ana varlık.
- `payload`: Olayın verisi. PII içermez, yalnızca referans id'leri taşır.

### Topic Topolojisi

Domain başına bir topic (`emek.booking`, `emek.payment`, vb.) tanımlanır. Event tipi mesaj attribute'unda taşınır ve subscription filtresiyle ayrıştırılır. Consumer'lar kendi subscription'larına sahiptir ve her subscription'ın kendi DLQ (Dead Letter Queue) yapılandırması vardır.

## Producer Ownership (Outbox Pattern)

Veri bütünlüğünü sağlamak için **transactional outbox** deseni kullanılır. Event, domain nesnesinin (ör. Booking, Payment) kaydedildiği transaction ile `outbox` tablosuna eklenir. `OutboxPublisher` arka planda çalışarak `PENDING` durumundaki event'leri `FOR UPDATE SKIP LOCKED` ile sahiplenir ve yayınlar.

## Transport Katmanı

Event transport portu `src/common/outbox/event-transport.ts` içinde tanımlanmıştır.

- **`LoggingEventTransport`**: Geliştirme/Test ortamlarında event'leri loglara yazar.
- **`PubSubEventTransport`**: Üretim ortamında event'leri Google Pub/Sub'a gönderir.

## Consumer Runner Pipeline

Gelen mesajlar `EventConsumerRunner` tarafından aşağıdaki aşamalardan geçirilir (ADR-0020):

1. **Zarf Doğrulama (Validate Envelope):** Mesaj standart zarf formatında mı?
2. **Sürüm Kontrolü (Version Check):** Sürüm destekleniyor mu?
3. **Tekilleştirme (Deduplicate):** `processed_events` tablosunda `(consumer, event_id)` var mı?
4. **Dispatch:** İlgili consumer'ın `handle()` metodu çağrılır.
5. **Sonuç (Ack/Nack):** İşlem başarılıysa ACK, geçici hata varsa NACK (Pub/Sub tarafından tekrar denenir), kalıcı hata varsa DLQ'ya yönlendirilir ve ACK edilir.

## İdempotency ve At-Least-Once Semantics

Event teslimi "at-least-once" (en az bir kez) olarak garanti edilir. Bu yüzden her consumer'ın **idempotent** (tekrar edilebilir) olması zorunludur. Kalıcı tekilleştirme `processed_events` tablosuna kaydedilir (`consumer`, `event_id` çifti ile). Redis sadece optimizasyon amacıyla (ikincil olarak) kullanılabilir.

## Retry ve Backoff

- **Outbox Publisher:** Yayınlama sırasında oluşacak geçici ağ hataları için publisher kendi içinde "jitter" ile yeniden deneme mantığı kullanır (üstel geri çekilme).
- **Pub/Sub Nack:** Consumer tarafındaki geçici hatalarda NACK dönülür. Pub/Sub, mesajı bir backoff politikası çerçevesinde (min 10s, max 600s) yeniden iletir.

## Dead Letter Queue (DLQ)

Tüketim sırasında alınan kalıcı hatalar (örn. schema hatası, geçersiz veri referansı) `FailureClassification.PERMANENT` olarak işaretlenir. Bu durumda mesaj, `dead_letter_events` tablosuna kaydedilerek DLQ'ya yönlendirilir.
Hata sınıflandırması `failure-classifier.ts` içinde belirlenir. DLQ, sessizce dolmaması için ölçülür (metrics) ve alarmlanır.

## Sıralama Garantileri (Ordering)

Varsayılan olarak mesaj sıralaması garanti edilmez. Sıranın önemli olduğu durumlarda (ör. ödeme onay durumları), `aggregateId` üzerinden ordering key veya durum monotonluğu kontrolleri kullanılır. Düzensiz gelen olaylar, eski bir durumu eziyorsa atlanır.

## Yerel Geliştirme

Geliştirme ortamında Pub/Sub emulator kullanılabilir (`npm run infra:up:events` ile). `setup-pubsub.ts` betiği emulator üzerinde gerekli topic ve subscription topolojisini otomatik kurar. Outbox, config aracılığıyla emulator transport'una bağlanır.

## Observability

Tüm event yaşam döngüsü boyunca yapılandırılmış loglar (structured log) ve `EventMetrics` kullanılır:

- Yayınlanma gecikmesi (outbox lag).
- Mesaj işleme süreleri.
- Duplicate detection oranı.
- DLQ (dead letter) sayacı.
- Consumer hata metrikleri.

**Metrik adı bir sözleşmedir (Faz 14 kapanışı, R-92).** `EventMetrics` her ölçümü
sabit adlı bir log satırı olarak, **`metric` alanında** yazar (`event.publish.success`,
`event.publish.failure`, `event.consumer.success`, `event.consumer.failure`,
`event.consumer.duplicate`, `event.dlq.added`, `event.outbox.stats`). Cloud Logging
log tabanlı metrikleri doğrudan bu alana ve bu adlara bağlanır.

Faz 14 kapanışında `monitoring.tf`'teki worker/consumer filtresinin var olmayan bir
alana (`jsonPayload.event`) bağlı olduğu görüldü: uygulama o alanı hiçbir yerde
yazmıyor, dolayısıyla metrik **kalıcı olarak sıfır** üretecekti. Filtre gerçek alana
bağlandı. Ders: alan veya ad değiştirmek **alarmı sessizce kapatır** — bu yüzden
adlar kapalı küme olarak tutulur ve değişiklikleri `monitoring.tf` ile birlikte
yapılır.

## Ölçülen davranış (Faz 14, EXP-007 S-10/S-12)

Ölçüm ortamı **yerel** ve taşıma **Pub/Sub emulator**'üdür; aşağıdaki sayılar gerçek
Pub/Sub lag'i hakkında iddia üretmez (bkz. `docs/research/experiments/exp-007-performance-baseline.md` §10.9).

- 50/200/500'lük partilerde teslim **tam**: yayınlanan = üretilen, işlenen = üretilen,
  duplicate **etki** 0, DLQ 0, `FAILED` outbox satırı 0.
- `published → processed` p95: 49–62 ms.
- **Tavanı koyan şey, outbox yayıncısının olayları sırayla göndermesidir.**
  `OutboxPublisher.dispatch` her event için bir `publish` **ve** bir `UPDATE` yapar,
  ikisini de bekleyerek; dolayısıyla instance başına throughput ≈ `1 / (event başına
tur süresi)` — burada ~14 ms tur, ~70 event/sn (üç koşu: 51–73). Turun içinde hangi
  bacağın (Pub/Sub mu, Postgres mi) baskın olduğu **ölçülmedi**; kanıtlanan şey
  serileştirmenin kendisidir. Gerçek Pub/Sub'da tur uzayacağı için tavanın **düşmesi**
  beklenir. Bu **R-95** olarak açık kaydedilmiştir;
  paralelleştirme `orderingKey` sırasını bozmadan yapılmak zorundadır (anahtarlar arası
  paralellik güvenli, anahtar içi değil) ve ayrı bir tasarım kararıdır.

Kurtarma davranışı `test/failure-recovery.integration.spec.ts` ile sözleşmeye bağlanmıştır:
kirada olan event ikinci instance tarafından alınamaz, kira dolunca yeniden sahiplenilir,
`FAILED` kayıt kendiliğinden yeniden denenmez; consumer geçici hatada dedup işareti geri
alınır (yeniden teslim işe yarar), kalıcı hatada işaret kalır (yeniden teslim ikinci bir
yan etki üretmez).

## Güvenlik

- **PII Yok:** Event payload'larında isim, telefon, koordinat, kimlik bilgisi veya kredi kartı gibi PII verileri yer almaz. Sadece ID referansları taşınır ve asıl veri yetki sınırları içindeki API çağrısıyla alınır.
- İşlemler, domain sınırlarında gerçekleştirilir.

## Consumer Ekleme Rehberi

1. `packages/api-contracts/events/` altında ilgili event tipini tanımla ve sözlüğe ekle (`event-catalog.md`).
2. `src/common/events/consumers/` altında `EventConsumer` arayüzünü uygulayan bir sınıf oluştur.
3. Consumer, idempotency için sadece state'ini değiştirecek veri tabanı işlemlerini transaction içinde gerçekleştirmelidir. Runner tekilleştirmeyi senin adına yapar.
4. Consumer sınıfını `@Injectable()` ile işaretle ve `EVENT_CONSUMERS` provider dizisine ekle.
5. Unit testlerini (başarı, duplicate event, hata senaryoları) yaz.
