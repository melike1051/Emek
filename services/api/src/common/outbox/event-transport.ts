/**
 * Event taşıma portu.
 *
 * Outbox, event'i veritabanına yazmaktan sorumludur; **nereye** yayınlandığı bu portun
 * arkasındadır. Faz 2'de yerel bir transport kullanılır; Google Pub/Sub adapter'ı
 * Faz 9'da aynı porta bağlanır (ADR-0010) ve domain kodu değişmez.
 */

export interface OutboundEvent {
  eventId: string;
  eventType: string;
  eventVersion: number;
  occurredAt: Date;
  subject: { type: string; id: string | null };
  correlationId: string | null;
  payload: Record<string, unknown>;
}

export interface EventTransport {
  /** Başarısızlıkta hata fırlatır; outbox yeniden dener. */
  publish(event: OutboundEvent): Promise<void>;
}

export const EVENT_TRANSPORT = Symbol('EVENT_TRANSPORT');
