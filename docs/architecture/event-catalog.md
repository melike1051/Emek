# Event Catalog

Tek doğruluk kaynağı. Bir event burada tanımlanmadan yayınlanmaz; şemalar Faz 9'da
`packages/api-contracts/events/` altında kodlanır.

## Zarf (envelope) — tüm eventler için ortak

```json
{
  "eventId": "uuid", // idempotency anahtarı; consumer bunu kontrol eder
  "eventType": "BookingCreated",
  "eventVersion": 1,
  "occurredAt": "2026-09-20T10:00:00Z",
  "producer": "services/api",
  "correlationId": "uuid", // istek zincirini izlemek için
  "subject": { "type": "booking", "id": "uuid" },
  "data": {}
}
```

## Kurallar

1. **Payload minimumdur.** Kimlik referansları (id) taşınır; kişisel veri, konum geçmişi,
   ham kimlik bilgisi, ödeme detayı taşınmaz. Consumer ihtiyacı olan veriyi yetkisiyle okur.
2. **At-least-once teslim varsayılır.** Her consumer `eventId` ile idempotenttir.
3. **Sıra garanti değildir.** Sıra önemliyse ordering key (`booking_id`) veya durum monotonluğu.
4. **Şema evrimi geriye dönük uyumlu.** Alan kaldırma/anlam değiştirme `eventVersion` artırır.
5. **Transactional outbox zorunlu** — event, domain değişikliğiyle aynı transaction'da yazılır.
6. Event **geçmiş zaman** ile adlandırılır; komut değildir (`BookingCreated`, `PaymentReleased`).

## Event sözlüğü (v1)

| Event                  | Tetikleyici                   | `data` (özet)                                                 | Ana tüketiciler                                                                 |
| ---------------------- | ----------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `UserRegistered`       | yeni user kaydı tamamlandı    | `userId`, `roles`                                             | notification, analytics                                                         |
| `IdentityVerified`     | verification `VERIFIED`       | `userId`, `verificationLevel`, `assuranceLevel`               | provider onboarding, notification, analytics, audit                             |
| `ProviderApproved`     | admin/otomatik provider onayı | `userId`, `approvedBy`                                        | matching (uygunluk), notification, analytics                                    |
| `BookingCreated`       | booking_request → booking     | `bookingId`, `requestId`, `customerId`, `serviceId`, `window` | matching, notification, analytics, safety/fraud                                 |
| `BookingMatched`       | matching sonucu üretildi      | `bookingId`, `providerId`, `algorithmVersion`, `overallScore` | notification, analytics, research                                               |
| `ProviderAccepted`     | provider kabul etti           | `bookingId`, `providerId`                                     | notification, analytics (**ödeme yetkilendirme buradan tetiklenmez**)           |
| `BookingConfirmed`     | booking `CONFIRMED`           | `bookingId`                                                   | notification, analytics                                                         |
| `PaymentAuthorized`    | PSP authorization             | `paymentId`, `bookingId`, `amountMinor`, `currency`           | booking state, notification, analytics                                          |
| `PaymentReleased`      | settlement serbest bırakıldı  | `paymentId`, `bookingId`, `amountMinor`                       | ledger/reconciliation, notification, analytics                                  |
| `PaymentRefunded`      | iade (tam veya kısmi)         | `paymentId`, `bookingId`, `refundedMinor`, `partial`          | ledger, notification, analytics                                                 |
| `ServiceStarted`       | check-in / `IN_PROGRESS`      | `bookingId`, `safetySessionId`, `startedAt`                   | safety, notification, analytics                                                 |
| `ServiceCompleted`     | check-out / `COMPLETED`       | `bookingId`, `completedAt`, `durationMinutes`                 | review daveti, analytics (release akışı booking guard'ından senkron tetiklenir) |
| `SafetyAlertRaised`    | panic veya `HIGH_RISK`+       | `safetySessionId`, `bookingId`, `severity`, `source`          | emergency workflow, admin, notification, audit                                  |
| `DisputeOpened`        | dispute açıldı                | `disputeId`, `bookingId`, `reason`                            | payment (release bloğu), admin, notification, audit                             |
| `DisputeResolved`      | operatör kararı verildi       | `disputeId`, `bookingId`, `status`                            | payment, admin, notification, analytics                                         |
| `ServiceEvidenceAdded` | kanıt dokümanı doğrulandı     | `bookingId`, `documentId`, `documentType`                     | safety, dispute dosyası, analytics                                              |
| `ReviewCreated`        | review yazıldı                | `reviewId`, `bookingId`, `revieweeId`, `rating`               | quality score güncelleme, analytics                                             |

## Uygulama durumu

| Bileşen                                           | Durum                                                     |
| ------------------------------------------------- | --------------------------------------------------------- |
| `outbox` tablosu + transactional yazım            | ✅ Faz 2                                                  |
| Publisher (poll + retry + backoff + FAILED eşiği) | ✅ Faz 2                                                  |
| `processed_events` tablosu (consumer idempotency) | ✅ Faz 2 (tablo hazır, consumer'lar Faz 9)                |
| `EventTransport` portu                            | ✅ Faz 2 — yerel log transport'u; Pub/Sub adapter'ı Faz 9 |
| Topic/subscription topolojisi, DLQ, observability | ⏳ Faz 9                                                  |
| Şema dosyaları (`packages/api-contracts/events/`) | ⏳ Faz 9                                                  |

Yayınlanan eventler: `UserRegistered`, `ProviderProfileSubmitted` (Faz 2), `IdentityVerified` (Faz 3).

## Topic ve subscription yapısı (Faz 9)

- **Domain başına topic** (`emek.booking`, `emek.payment`, `emek.safety`, gerekirse `emek.identity`);
  event tipi mesaj attribute'unda taşınır ve subscription filtresiyle ayrıştırılır. Event tipi
  başına ayrı topic ancak ölçülebilir bir ihtiyaç doğduğunda bölünerek elde edilir (ADR-0010 §8).
- Her consumer kendi subscription'ına sahiptir; subscription başına retry politikası + DLQ.
- DLQ derinliği ve mesaj yaşı alarmlıdır.
- Yerel geliştirmede Pub/Sub emulator kullanılır.

## Kritik akışlar event'e bağlı bekletilmez

Ödeme sağlayıcısına giden `authorize`/`capture`/`refund` çağrıları, booking state geçişi ve panic
kaydı **senkron** tamamlanır; event bunların yanında yayınlanır. Bir event'ten para hareketi
tetiklenmez: teslim at-least-once olduğu için redelivery çift yetkilendirme üretir ve
`payment_events.external_event_id` yalnızca **gelen** webhook'ları tekilleştirir (ADR-0009 §5-6).

`SafetyAlertRaised` publish edilemezse olay kaydı yine de DB'de durur ve outbox tarafından yeniden
denenir. Bu nedenle outbox altyapısı Faz 2'de kurulur (ADR-0010 §2).
