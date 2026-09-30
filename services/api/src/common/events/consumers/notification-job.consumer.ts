import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Logger } from 'pino';
import { AppConfigService } from '../../config/app-config.service';
import { ROOT_LOGGER } from '../../logging/logging.tokens';
import {
  FailureClassification,
  type ConsumedEvent,
  type ConsumerResult,
  type EventConsumer,
} from '../event-consumer';

/**
 * Bildirim işi consumer'ı: domain event'lerini **push** bildirim işlerine çevirir; teslimatı
 * `NotificationDeliveryWorker` yapar (R-77).
 *
 * Alıcılar (R-76 düzeltmesi, Faz 16): event payload'ları çoğunlukla yalnız `bookingId` taşır
 * (PII yok — CLAUDE.md §4). Alıcı, runner'ın verdiği **aynı** bağlantıda `bookings` satırından
 * çözülür; böylece iş, tekilleştirme işaretiyle aynı transaction'dadır (ADR-0020 §4-5).
 *
 * Kim neyi alır — taraf görünümü ilkesiyle (ADR-0019 §9):
 * - sağlayıcı: yeni talep (`BookingMatched`), ödeme güvende (`PaymentAuthorized`), ödeme aktarıldı;
 * - müşteri: sağlayıcı onayladı → öde (`BookingConfirmed`), hizmet başladı, tamamlandı, iade;
 * - iki taraf: iptal, itiraz sonucu;
 * - `SafetyAlertRaised` taraflara **gitmez**: karşı tarafın paniği/riski taraflara gösterilmez;
 *   operatörler konsoldadır. `BookingCreated` müşterinin kendi eylemidir — bildirilmez.
 *
 * Kanallar (R-77): her olay push'a gider. Zamana duyarlı olanlar (yeni talep, iptal) ayrıca SMS'e,
 * kayıt niteliğindekiler (ödeme aktarıldı/iade, itiraz sonucu) ayrıca e-postaya. `disabled`
 * sağlayıcılı kanala iş üretilmez. İletişim bilgisi işe **yazılmaz**; worker gönderim anında
 * `users`'tan okur (anonimleştirilmiş hesaba gitmez).
 *
 * İdempotency: `UNIQUE(event_id, channel, recipient_user_id)`.
 */

type Party = 'CUSTOMER' | 'PROVIDER';
type Channel = 'PUSH' | 'SMS' | 'EMAIL';

interface NotificationTemplate {
  templateKey: string;
  recipients: readonly Party[];
  /** PUSH her zaman; SMS/EMAIL yalnız burada listelenen olaylar için. */
  extraChannels?: readonly Channel[];
  /** Şablon verisi — yalnız referans/kimlik, PII yok. */
  extractTemplateData: (payload: Record<string, unknown>) => Record<string, unknown>;
}

const bookingRef = (p: Record<string, unknown>) => ({ bookingId: p['bookingId'] });

const TEMPLATES: Record<string, NotificationTemplate> = {
  BookingMatched: {
    templateKey: 'booking.new_request',
    recipients: ['PROVIDER'],
    extraChannels: ['SMS'],
    extractTemplateData: bookingRef,
  },
  BookingConfirmed: {
    templateKey: 'booking.confirmed',
    recipients: ['CUSTOMER'],
    extractTemplateData: bookingRef,
  },
  BookingCancelled: {
    templateKey: 'booking.cancelled',
    recipients: ['CUSTOMER', 'PROVIDER'],
    extraChannels: ['SMS'],
    extractTemplateData: bookingRef,
  },
  ServiceStarted: {
    templateKey: 'service.started',
    recipients: ['CUSTOMER'],
    extractTemplateData: bookingRef,
  },
  ServiceCompleted: {
    templateKey: 'service.completed',
    recipients: ['CUSTOMER'],
    extractTemplateData: bookingRef,
  },
  PaymentAuthorized: {
    templateKey: 'payment.authorized',
    recipients: ['PROVIDER'],
    extractTemplateData: (p) => ({ paymentId: p['paymentId'], bookingId: p['bookingId'] }),
  },
  PaymentReleased: {
    templateKey: 'payment.released',
    recipients: ['PROVIDER'],
    extraChannels: ['EMAIL'],
    extractTemplateData: (p) => ({ paymentId: p['paymentId'], bookingId: p['bookingId'] }),
  },
  PaymentRefunded: {
    templateKey: 'payment.refunded',
    recipients: ['CUSTOMER'],
    extraChannels: ['EMAIL'],
    extractTemplateData: (p) => ({
      paymentId: p['paymentId'],
      bookingId: p['bookingId'],
      partial: p['partial'],
    }),
  },
  DisputeResolved: {
    templateKey: 'dispute.resolved',
    recipients: ['CUSTOMER', 'PROVIDER'],
    extraChannels: ['EMAIL'],
    extractTemplateData: (p) => ({ disputeId: p['disputeId'], bookingId: p['bookingId'] }),
  },
};

/** Şablon kapsamı testi için: kanal → o kanala iş üreten şablon anahtarları. */
export const TEMPLATE_KEYS_BY_CHANNEL: Record<'SMS' | 'EMAIL', string[]> = {
  SMS: Object.values(TEMPLATES)
    .filter((t) => t.extraChannels?.includes('SMS'))
    .map((t) => t.templateKey),
  EMAIL: Object.values(TEMPLATES)
    .filter((t) => t.extraChannels?.includes('EMAIL'))
    .map((t) => t.templateKey),
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class NotificationJobConsumer implements EventConsumer {
  readonly consumerName = 'notification-job';
  readonly eventTypes = Object.keys(TEMPLATES);

  constructor(
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    private readonly config: AppConfigService,
  ) {}

  private channelsFor(template: NotificationTemplate): Channel[] {
    const enabled: Record<Channel, boolean> = {
      PUSH: true,
      SMS: this.config.env.SMS_PROVIDER !== 'disabled',
      EMAIL: this.config.env.EMAIL_PROVIDER !== 'disabled',
    };
    return ['PUSH', ...(template.extraChannels ?? [])].filter(
      (c) => enabled[c as Channel],
    ) as Channel[];
  }

  async handle(event: ConsumedEvent, client: PoolClient): Promise<ConsumerResult> {
    const template = TEMPLATES[event.eventType];
    if (template === undefined) {
      return { success: true };
    }

    const bookingId = event.payload['bookingId'];
    if (typeof bookingId !== 'string' || !UUID.test(bookingId)) {
      // Sözleşme dışı payload: tekrar denemek düzeltmez.
      return {
        success: false,
        classification: FailureClassification.PERMANENT,
        reason: 'Bildirim için bookingId eksik ya da geçersiz',
      };
    }

    try {
      const booking = await client.query<{ customer_id: string; provider_id: string | null }>(
        `SELECT customer_id, provider_id FROM bookings WHERE id = $1`,
        [bookingId],
      );
      const row = booking.rows[0];
      if (row === undefined) {
        // Event, rezervasyon satırıyla aynı transaction'da outbox'a yazılır; satır yoksa event
        // bozuktur (ya da başka bir ortamdandır). Bildirim uydurulmaz.
        this.logger.warn(
          { eventId: event.eventId, eventType: event.eventType },
          'Bildirim alıcısı çözülemedi: rezervasyon yok',
        );
        return { success: true };
      }

      // Alıcı başına taraf (`audience`) şablon verisine yazılır: bildirim doğru ekranı açar
      // (sağlayıcı paneli / müşteri randevuları). Aynı kişi iki taraf olamaz (CHECK).
      const recipients = new Map<string, Party>();
      for (const party of template.recipients) {
        const id = party === 'CUSTOMER' ? row.customer_id : row.provider_id;
        if (id !== null) recipients.set(id, party);
      }

      for (const [recipientId, audience] of recipients) {
        const templateData = JSON.stringify({
          ...template.extractTemplateData(event.payload),
          audience,
        });
        for (const channel of this.channelsFor(template)) {
          await client.query(
            `INSERT INTO notification_jobs
               (event_id, event_type, channel, recipient_user_id, template_key, template_data)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (event_id, channel, recipient_user_id) DO NOTHING`,
            [
              event.eventId,
              event.eventType,
              channel,
              recipientId,
              template.templateKey,
              templateData,
            ],
          );
        }
      }
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
