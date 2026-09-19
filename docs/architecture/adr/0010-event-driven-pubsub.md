# ADR-0010 — Pub/Sub ile Event-Driven Yan Akışlar

- Durum: Accepted (2026-09-20)
- Faz: 9
- Blueprint: §16

## Bağlam

Bir booking oluştuğunda matching, bildirim, analitik ve safety/fraud alt akışları tetiklenmeli.
Bunları senkron çağırmak request latency'sini bu akışların en yavaşına bağlar ve birinin hatası
ana akışı düşürür.

## Karar

1. **Yan akışlar Google Pub/Sub üzerinden asenkron.** Ana request path'i yalnızca kendi
   transaction'ını tamamlar ve event yayınlar.
2. **Transactional outbox:** event, domain değişikliğiyle **aynı DB transaction'ında** outbox
   tablosuna yazılır; ayrı bir publisher Pub/Sub'a gönderir. "DB commit edildi ama event kayboldu"
   veya tersi durumu kabul edilmez.
   **Outbox tablosu ve publisher Faz 2'de kurulur**, Faz 9'da değil: `IdentityVerified` (Faz 3),
   `PaymentAuthorized` (Faz 5) ve `SafetyAlertRaised` (Faz 8) garanti olmadan yayınlanamaz.
   Faz 9 yalnızca topic/subscription topolojisi, DLQ ve event observability'yi ekler.
3. **Consumer'lar idempotent.** At-least-once teslim varsayılır; her consumer `event_id` ile
   işlenmiş kaydı kontrol eder. Kalıcı kayıt DB'deki `processed_events` tablosundadır; Redis
   yalnızca hızlı yoldur (ADR-0003). Duplicate event testi zorunlu.
4. **Event sözlüğü merkezîdir:** `docs/architecture/event-catalog.md` + şemalar
   `packages/api-contracts/events/`. Event adı/şeması doküman güncellenmeden değişmez.
   Şema değişimi geriye dönük uyumlu olur veya yeni sürüm adı alır (`BookingCreated.v2`).
5. **Retry + dead-letter:** her subscription'da exponential backoff ve DLQ. DLQ derinliği
   alarmlıdır; DLQ sessizce dolmaz.
6. **Sıralama garantisi varsayılmaz.** Sıra önemli olan yerlerde ordering key (ör. `booking_id`)
   veya durum monotonluğu kontrolü kullanılır.
7. **Kritik akış senkron kalır.** Ödeme yetkilendirme **çağrısı ve sonucu**, booking geçişi ve
   panic kaydı event'e bağlı bekletilmez; event bunların yanında yayınlanır. At-least-once teslimli
   bir event'ten PSP'ye `authorize` çağırmak çift yetkilendirme riskidir (ADR-0009 §6).
8. **Topic sayısı ihtiyaca göre büyür.** Başlangıçta domain başına üç topic:
   `emek.booking`, `emek.payment`, `emek.safety` (+ gerekirse `emek.identity`). Event tipi
   attribute olarak taşınır ve subscription filtresiyle ayrıştırılır. Event tipi başına ayrı topic,
   filtreleme veya DLQ izolasyonu **ölçülebilir biçimde** sorun olduğunda bölünerek elde edilir —
   15 topic'i tek consumer bile yokken Terraform'da tanımlamak gereksiz karmaşıklıktır.

## Event sözlüğü (v1)

`UserRegistered`, `IdentityVerified`, `ProviderApproved`, `BookingCreated`, `BookingMatched`,
`ProviderAccepted`, `BookingConfirmed`, `PaymentAuthorized`, `PaymentReleased`, `PaymentRefunded`,
`ServiceStarted`, `ServiceCompleted`, `SafetyAlertRaised`, `DisputeOpened`, `ReviewCreated`.

## Gerekçe

Gevşek bağlama core latency'sini korur ve alt sistemlerin bağımsız ölçeklenmesine izin verir.
Outbox olmadan event-driven mimari sessiz veri kaybı üretir; bu ödeme ve safety'de kabul edilemez.

## Sonuçlar

- Eventual consistency: admin dashboard ve analytics anlık tutarlı değildir; UI bunu varsayar.
- Event lag ölçülür ve SLO'ya bağlanır.
- Yerel geliştirmede Pub/Sub emulator kullanılır (Faz 1'de compose'a eklenir).
- Event payload'ları kişisel veri minimizasyonuna tabidir: id referansı taşınır, hassas alan taşınmaz.

## Alternatifler

- **Senkron çağrılar (reddedildi):** latency ve hata yayılımı.
- **Yalnız DB tabanlı kuyruk (ertelendi):** GCP yönetilen Pub/Sub varken gereksiz bakım yükü;
  outbox tablosu yine kullanılıyor.
