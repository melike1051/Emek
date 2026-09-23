import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { POSTGRES_POOL } from '../../database/database.tokens';
import { ROOT_LOGGER } from '../../logging/logging.tokens';
import {
  FailureClassification,
  type ConsumedEvent,
  type ConsumerResult,
  type EventConsumer,
} from '../event-consumer';

/**
 * Bildirim işi consumer'ı.
 *
 * Domain event'lerini bildirim işlerine çevirir. Bildirim işleri `notification_jobs`
 * tablosunda saklanır; gerçek teslimat (push, SMS, email) henüz bağlanmadı — Faz 10
 * yalnızca admin görünürlüğü ve manuel yeniden kuyruklama ekledi (R-77). Bu consumer
 * yalnızca **işi oluşturur**.
 *
 * İdempotency: `notification_jobs.UNIQUE(event_id, channel, recipient_user_id)` ile
 * aynı event ikinci kez iş oluşturamaz.
 *
 * **Bilinen kusur (R-76):** `BookingCreated` dışındaki şablonlar alıcı olarak
 * gerçek kullanıcı yerine `bookingId`'yi yazıyor (UUID tipi tuttuğu için sessizce
 * yanlış). Gerçek teslimat açılmadan önce düzeltilmesi gerekir.
 */

/** Bildirim şablonu eşleme: event type → şablon anahtarı ve alıcı çıkarma. */
interface NotificationTemplate {
  templateKey: string;
  /** Event payload'ından alıcı userId'sini çıkarır. null dönerse bildirim oluşturulmaz. */
  extractRecipientId: (payload: Record<string, unknown>) => string | null;
  /** Bildirim template verisi (yalnızca referans/id, PII yok). */
  extractTemplateData: (payload: Record<string, unknown>) => Record<string, unknown>;
}

const TEMPLATES: Record<string, NotificationTemplate> = {
  BookingCreated: {
    templateKey: 'booking.created',
    extractRecipientId: (p) => asString(p['customerId']),
    extractTemplateData: (p) => ({
      bookingId: p['bookingId'],
      serviceId: p['serviceId'],
    }),
  },
  BookingConfirmed: {
    templateKey: 'booking.confirmed',
    extractRecipientId: (p) => asString(p['bookingId']),
    // Alıcıyı booking'den çıkarmak gerekir ama payload'da yalnızca bookingId var.
    // Consumer DB'den okuyabilir ama bu fazda alıcıyı payload'dan alıyoruz.
    // bookingId'yi geçici olarak alıcı yerine koyamayız — null dönersek iş oluşturulmaz.
    extractTemplateData: (p) => ({ bookingId: p['bookingId'] }),
  },
  BookingCancelled: {
    templateKey: 'booking.cancelled',
    extractRecipientId: (p) => asString(p['bookingId']),
    extractTemplateData: (p) => ({ bookingId: p['bookingId'] }),
  },
  ServiceStarted: {
    templateKey: 'service.started',
    extractRecipientId: (p) => asString(p['bookingId']),
    extractTemplateData: (p) => ({ bookingId: p['bookingId'] }),
  },
  ServiceCompleted: {
    templateKey: 'service.completed',
    extractRecipientId: (p) => asString(p['bookingId']),
    extractTemplateData: (p) => ({ bookingId: p['bookingId'] }),
  },
  PaymentAuthorized: {
    templateKey: 'payment.authorized',
    extractRecipientId: (p) => asString(p['bookingId']),
    extractTemplateData: (p) => ({
      paymentId: p['paymentId'],
      bookingId: p['bookingId'],
      amountMinor: p['amountMinor'],
    }),
  },
  PaymentReleased: {
    templateKey: 'payment.released',
    extractRecipientId: (p) => asString(p['bookingId']),
    extractTemplateData: (p) => ({
      paymentId: p['paymentId'],
      bookingId: p['bookingId'],
    }),
  },
  PaymentRefunded: {
    templateKey: 'payment.refunded',
    extractRecipientId: (p) => asString(p['bookingId']),
    extractTemplateData: (p) => ({
      paymentId: p['paymentId'],
      bookingId: p['bookingId'],
      partial: p['partial'],
    }),
  },
  SafetyAlertRaised: {
    templateKey: 'safety.alert',
    extractRecipientId: (p) => asString(p['bookingId']),
    extractTemplateData: (p) => ({
      safetySessionId: p['safetySessionId'],
      bookingId: p['bookingId'],
      severity: p['severity'],
      source: p['source'],
    }),
  },
};

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

@Injectable()
export class NotificationJobConsumer implements EventConsumer {
  readonly consumerName = 'notification-job';
  readonly eventTypes = Object.keys(TEMPLATES);

  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  async handle(event: ConsumedEvent): Promise<ConsumerResult> {
    const template = TEMPLATES[event.eventType];
    if (template === undefined) {
      return { success: true }; // Tanımsız event type — sorun değil, atla.
    }

    const recipientId = template.extractRecipientId(event.payload);
    if (recipientId === null) {
      // Alıcı belirlenemedi (payload'da beklenen id alanı yok) — `recipient_user_id`
      // UUID sütunudur, uydurma bir değer yazmak type hatasıyla sonsuz retry'a yol
      // açardı; bu event için iş oluşturulmaz. Booking event'lerinde bookingId'nin
      // gerçek alıcıya çözümlenmesi ayrı ve daha geniş bir kusurdur (R-76): o
      // şablonlar burada değil, `extractRecipientId`'de bookingId'yi (yanlışlıkla)
      // geçerli bir değer olarak döndürüyor.
      this.logger.warn(
        { eventId: event.eventId, eventType: event.eventType },
        'Bildirim alıcısı belirlenemedi — iş oluşturulmadı',
      );
      return { success: true };
    }

    const templateData = template.extractTemplateData(event.payload);

    try {
      // UNIQUE constraint (event_id, channel, recipient_user_id) idempotency sağlar.
      await this.pool.query(
        `INSERT INTO notification_jobs
           (event_id, event_type, channel, recipient_user_id, template_key, template_data)
         VALUES ($1, $2, 'IN_APP', $3, $4, $5)
         ON CONFLICT (event_id, channel, recipient_user_id) DO NOTHING`,
        [
          event.eventId,
          event.eventType,
          recipientId,
          template.templateKey,
          JSON.stringify(templateData),
        ],
      );

      return { success: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Bilinmeyen hata';
      return {
        success: false,
        classification: FailureClassification.TRANSIENT,
        reason: reason.slice(0, 500),
      };
    }
  }
}
