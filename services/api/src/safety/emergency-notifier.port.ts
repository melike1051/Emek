import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { ROOT_LOGGER } from '../common/logging/logging.tokens';

/**
 * Acil durum bildirim portu (ADR-0019 §8).
 *
 * **Bugün hiçbir dış acil durum kurumuna (112, polis, ambulans, özel güvenlik)
 * entegrasyon yoktur** ve kod ya da doküman böyle bir entegrasyon iddia etmez.
 * Panik kaydının garantili yolu veritabanıdır: olay, oturum durumu, audit ve
 * outbox'taki `SafetyAlertRaised` aynı transaction'da yazılır. Bu port, commit'ten
 * **sonra** çağrılan en iyi çaba (best effort) bir hızlandırıcıdır — operatör
 * paneline anlık bildirim ya da ileride sözleşmesi ve hukuki dayanağı olan bir
 * dış kurum adaptörü buraya takılır. TODO(legal): dış kurum entegrasyonu ve
 * hangi verinin paylaşılacağı hukuk görüşü gerektirir (R-59).
 *
 * Portun hatası panik isteğini **başarısız kılmaz**: kayıt zaten kalıcıdır ve
 * outbox yayını at-least-once garantilidir.
 */
export interface EmergencyAlert {
  sessionId: string;
  bookingId: string;
  eventId: string;
  raisedBy: 'PROVIDER' | 'CUSTOMER';
  category: string | null;
  occurredAt: Date;
}

export interface EmergencyNotifier {
  notify(alert: EmergencyAlert): Promise<void>;
}

export const EMERGENCY_NOTIFIER = Symbol('EMERGENCY_NOTIFIER');

/**
 * Varsayılan uygulama: operasyon kanalına yapılandırılmış bir **alarm log'u**.
 *
 * Log tabanlı alarm politikası (Faz 13) bu satıra bağlanır. Koordinat ve kişi
 * bilgisi yazılmaz; operatör ayrıntıyı yetkili uçtan (audit'li) okur.
 */
@Injectable()
export class LoggingEmergencyNotifier implements EmergencyNotifier {
  constructor(@Inject(ROOT_LOGGER) private readonly logger: Logger) {}

  async notify(alert: EmergencyAlert): Promise<void> {
    this.logger.error(
      {
        alert: 'SAFETY_EMERGENCY',
        sessionId: alert.sessionId,
        bookingId: alert.bookingId,
        eventId: alert.eventId,
        raisedBy: alert.raisedBy,
        category: alert.category,
        occurredAt: alert.occurredAt.toISOString(),
      },
      'güvenlik acil durumu: operatör müdahalesi gerekli',
    );
    await Promise.resolve();
  }
}
