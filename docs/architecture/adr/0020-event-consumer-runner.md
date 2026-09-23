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
   - Tekilleştirme (Deduplication - `processed_events` tablosu kontrolü)
   - Dağıtım (Dispatch to consumers)
   - Sonuç bildirme (Ack/Nack/DLQ)
3. **Hata Sınıflandırması (Failure Classification):** `failure-classifier.ts` hataları iki türe ayırır:
   - **Geçici Hatalar (Transient):** Bağlantı kopmaları, kilit bekleme (lock wait) hataları vb. Mesaj NACK edilerek Pub/Sub'ın backoff politikasıyla tekrar denemesi sağlanır.
   - **Kalıcı Hatalar (Permanent):** Geçersiz zarf, format bozukluğu, desteklenmeyen şema versiyonları gibi hatalar. Mesaj ACK edilir ve `dead_letter_events` tablosuna (DLQ) yazılır. Kalıcı hatalar için tekrar deneme yapılmaz.
4. **Tekilleştirme Yönetimi:** Consumer işlemlerinin başında olay `(consumer, event_id)` çifti ile `processed_events` tablosuna yazılır. Consumer geçici bir hata verirse, Pub/Sub'ın yeniden denediğinde tekrar işlenebilmesi için bu tekilleştirme kaydı `ROLLBACK` edilir.

## Alternatifler

- **Push-based Delivery vs. Pull-based:** Push-based (HTTP Webhook) kolaydır ancak yük altında (spike) servisi boğabilir. Pull-based (subscriber) ise kendi hızını belirleyebilir ve worker (işçi) havuzlarına kolayca dağıtılabilir. Pull-based seçildi.
- **In-process Runner vs. Sidecar:** Tüm tüketici mantığının ayrı bir sidecar (örn. Dapr) üzerinden yönetilmesi düşünüldü. Ancak, `EventConsumerRunner`'ın monolitik yapı içerisinde (NestJS modülü olarak) doğrudan kodlanması mevcut "Modular Monolith" (ADR-0010) kuralına daha uygundur ve deployment karmaşıklığını (dependency) azaltır.

## Sonuçlar ve Trade-off'lar

- **İzlenebilirlik (Observability):** Başarılı ve başarısız tüketim metrikleri, duplicate algılamaları ve DLQ yazımları tek merkezden izlenir.
- **Deduplication Güvenilirliği:** Tekilleştirme mantığı kalıcı veritabanına bağlı olduğu için geçici kesintilerden veya yeniden başlatmalardan etkilenmez.
- **Kompleksite Artışı:** İşletim pipeline'ı ve geçici hata durumunda `rollbackDeduplication` gibi mekanizmalar kod tabanına ek bir karmaşıklık getirir. Ancak "sessiz DLQ dolması" gibi sorunlar proaktif hata sınıflandırmasıyla engellenmiş olur.
