/**
 * Pub/Sub topic/subscription topolojisi — tek doğruluk kaynağı (ADR-0010 §8, ADR-0020).
 *
 * `pubsub-event-transport.ts` (producer), `pubsub-subscriber.service.ts` (consumer) ve
 * `scripts/setup-pubsub.ts` (emulator kurulumu) bu dosyadan içe aktarır. Böylece topic
 * adı veya subscription isimlendirmesi tek bir yerde değişir; üç ayrı kopyanın
 * birbirinden sürüklenmesi (Faz 7'de matching kısıtlarında görülen sınıf hatası) önlenir.
 *
 * `packages/api-contracts/events/topic-mapping.ts` bu haritanın belgelenmiş/test edilmiş
 * bir kopyasını taşır ama services/api tarafından **runtime'da import edilmez**: paket
 * ham `.ts` olarak yayınlandığı için (derlenmiş `dist` çıktısı yok), `tsc` ile üretilen
 * production build'inde çözülemezdi. Bu yüzden iki dosya arasında **kasıtlı, belgelenmiş**
 * bir çakışma riski vardır — event-driven.md'de not edilmiştir.
 */

export const EVENT_TOPIC_MAP: Readonly<Record<string, string>> = {
  BookingCreated: 'emek.booking',
  BookingMatched: 'emek.booking',
  BookingConfirmed: 'emek.booking',
  BookingCancelled: 'emek.booking',
  ServiceStarted: 'emek.booking',
  ServiceCompleted: 'emek.booking',
  PaymentAuthorized: 'emek.payment',
  PaymentReleased: 'emek.payment',
  PaymentRefunded: 'emek.payment',
  SafetyAlertRaised: 'emek.safety',
  UserRegistered: 'emek.identity',
  ProviderProfileSubmitted: 'emek.identity',
  IdentityVerified: 'emek.identity',
  DisputeOpened: 'emek.booking',
  DisputeResolved: 'emek.booking',
  ServiceEvidenceAdded: 'emek.booking',
};

export const DEFAULT_TOPIC = 'emek.booking';

export const ALL_TOPICS = ['emek.booking', 'emek.payment', 'emek.safety', 'emek.identity'] as const;

export type EventTopic = (typeof ALL_TOPICS)[number];

/** DLQ topic adı (Pub/Sub'ın kendi `deadLetterPolicy`si için — R-55, bkz. event-driven.md). */
export function dlqTopicFor(topic: string): string {
  return `${topic}.dlq`;
}

/**
 * `EventConsumerRunner` topic başına **tek** subscription bekler: runner event type'a göre
 * kayıtlı tüm consumer'lara kendi içinde dispatch eder. Consumer başına ayrı subscription
 * açmak aynı event'in birden fazla kez teslim edilmesine (ve gereksiz duplicate-detection
 * yüküne) yol açardı.
 */
export function coreSubscriptionNameFor(topic: string): string {
  return `${topic}.core-api`;
}
