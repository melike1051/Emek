# ADR-0020 — Event Consumer Runner Design

- Durum: Accepted (2026-09-22)
- Faz: 9
- Blueprint: §16

## Bağlam

Emek platformunda Phase 9 kapsamında Pub/Sub tabanlı "event-driven" yan akışlar devreye girmiştir (ADR-0010). Pub/Sub üzerinden asenkron mesajları (event'leri) işlemek üzere bir tüketici (consumer) yönetimi yapısına ihtiyaç vardır. İlgili yapı, "at-least-once" teslimat, hata kurtarma, yeniden deneme (retry) ve Dead Letter Queue (DLQ) gibi gereksinimleri karşılamalıdır.

## Karar

1. **Pull-based Consumer Runner:** Olayların Pub/Sub'dan alınarak işlenmesi (pull), `EventConsumerRunner` sınıfı tarafından tek bir boru hattında (pipeline) yürütülür. Pull-based model, sidecar veya HTTP push alternatiflerine göre uygulamanın kendi hızında (backpressure ile) işlem yapmasını sağlar.
2. **Pipeline Sırası:**
   - Zarf (Envelope) doğrulama
   - Sürüm kontrolü
   - Transaction açma (`UnitOfWork.withTransaction`)
   - Tekilleştirme (Deduplication - `processed_events`'e işaret, **aynı** transaction'da)
   - Dağıtım (Dispatch to consumers - aynı transaction bağlantısıyla)
   - Commit (işaret + iş etkisi birlikte)
   - Sonuç bildirme (Ack/Nack/DLQ)
3. **Hata Sınıflandırması (Failure Classification):** `failure-classifier.ts` hataları iki türe ayırır:
   - **Geçici Hatalar (Transient):** Bağlantı kopmaları, kilit bekleme (lock wait) hataları vb. Mesaj NACK edilerek Pub/Sub'ın backoff politikasıyla tekrar denemesi sağlanır.
   - **Kalıcı Hatalar (Permanent):** Geçersiz zarf, format bozukluğu, desteklenmeyen şema versiyonları gibi hatalar. Mesaj ACK edilir ve `dead_letter_events` tablosuna (DLQ) yazılır. Kalıcı hatalar için tekrar deneme yapılmaz.
4. **Tekilleştirme Yönetimi (tek transaction):** Runner her (consumer, event) çifti için bir transaction açar; `processed_events` işareti **o transaction'ın içine** yazılır ve aynı `PoolClient` consumer'ın `handle()` metoduna geçirilir. İşaret ile iş etkisi tek commit'te olur. Consumer başarısızlık bildirirse bu bir istisnaya çevrilir ve transaction geri alınır: işaret ile kısmi iş etkisi **birlikte** yok olur. Telafi edici bir `DELETE` yoktur; geri alma ROLLBACK'in kendisidir. Kalıcı hatada DLQ kaydı ile işaret ikinci bir transaction'da **birlikte** yazılır (olay yeniden denenmez, kurtarma manuel replay'dir).

   Bunun sözleşmeye yansıması: `EventConsumer.handle(event, client)`. Consumer, PostgreSQL yazmalarının tamamını verilen bağlantıda yapmak zorundadır. Havuzdan kendi bağlantısını alan bir consumer garantiyi sessizce kaybeder; tip imzası buna izin vermez.

5. **Çökme penceresi kapalıdır (R-75):** İşaretin iş etkisinden **ayrı** bir bağlantıda commit edildiği tasarımda süreç tam ikisinin arasında çökebilirdi (SIGKILL, OOM, Cloud Run instance eviction) — o yolda hiçbir `catch` bloğu çalışmaz. Satır kalır, Pub/Sub yeniden teslim ettiğinde runner "duplicate" der ve ACK eder: olay **sessizce** düşerdi, DLQ'ya bile girmeden. At-least-once teslim garantisi tam bu noktada at-most-once'a dönüyordu. Tek transaction bu pencereyi **yok eder**: çökme her zaman ROLLBACK'e denktir, yani olay hiç işlenmemiş sayılır ve yeniden teslim onu baştan işler.

   Bedeli, bağlantı tutma süresidir: her uçuştaki mesaj `handle()` boyunca bir havuz bağlantısı tutar. Bu yüzden Pub/Sub akış denetimi (`flowControl.maxMessages`) `DATABASE_POOL_MAX`'ın yarısıyla sınırlanır (diğer yarısı HTTP isteklerine kalır); sınırsız bırakılsaydı istemcinin varsayılanı (1000 eşzamanlı mesaj) havuzu tüketir, ack süresi dolar ve yeniden teslim yığılırdı. Uzun süren veya PostgreSQL dışına yan etki yazan bir consumer bu modele uymaz: böyle bir iş, etkisini kendi içinde idempotent yapmak ya da bir outbox/iş kuyruğu ile PostgreSQL sınırının içinde tutmak zorundadır.

## Alternatifler

- **Push-based Delivery vs. Pull-based:** Push-based (HTTP Webhook) kolaydır ancak yük altında (spike) servisi boğabilir. Pull-based (subscriber) ise kendi hızını belirleyebilir ve worker (işçi) havuzlarına kolayca dağıtılabilir. Pull-based seçildi.
- **In-process Runner vs. Sidecar:** Tüm tüketici mantığının ayrı bir sidecar (örn. Dapr) üzerinden yönetilmesi düşünüldü. Ancak, `EventConsumerRunner`'ın monolitik yapı içerisinde (NestJS modülü olarak) doğrudan kodlanması mevcut "Modular Monolith" (ADR-0010) kuralına daha uygundur ve deployment karmaşıklığını (dependency) azaltır.

## Sonuçlar ve Trade-off'lar

- **İzlenebilirlik (Observability):** Başarılı ve başarısız tüketim metrikleri, duplicate algılamaları ve DLQ yazımları tek merkezden izlenir.
- **Deduplication Güvenilirliği:** Tekilleştirme mantığı kalıcı veritabanına bağlı olduğu için geçici kesintilerden veya yeniden başlatmalardan etkilenmez.
- **Tekilleştirme ile iş etkisi atomiktir:** "İşlenmiş göründü ama hiç işlenmedi" durumu artık mümkün değildir; telafi edici silme mantığı ve onun kendi hata yolu kod tabanından çıktı.
- **Consumer'lar transaction sınırını paylaşır:** `handle()` kısa ve PostgreSQL'e kapalı kalmak zorundadır. Bu bir kısıttır; karşılığında her consumer kendi transaction'ını yönetmek zorunda kalmaz (sınırı runner çizer) ve eşzamanlılık havuz boyutuna bağlanır.
- **Kompleksite Artışı:** İşletim pipeline'ı hata sınıflandırması ve DLQ yönetimiyle birlikte kod tabanına ek karmaşıklık getirir. Ancak "sessiz DLQ dolması" gibi sorunlar proaktif hata sınıflandırmasıyla engellenmiş olur.
