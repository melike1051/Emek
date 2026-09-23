export const EVENT_TOPIC_MAP: Record<string, string> = {
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
  IdentityVerified: 'emek.identity',
  DisputeOpened: 'emek.booking',
  DisputeResolved: 'emek.booking',
  ProviderProfileSubmitted: 'emek.identity',
  ServiceEvidenceAdded: 'emek.booking',
};

export const ALL_TOPICS = ['emek.booking', 'emek.payment', 'emek.safety', 'emek.identity'] as const;
export type EventTopic = (typeof ALL_TOPICS)[number];
