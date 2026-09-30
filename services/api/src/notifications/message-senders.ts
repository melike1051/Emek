import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { ROOT_LOGGER } from '../common/logging/logging.tokens';
import type { EmailContent, SmsContent } from './message-templates';

export const SMS_SENDER = Symbol('SMS_SENDER');
export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

/**
 * SMS/e-posta gönderiminin sonucu (R-77):
 * - `SENT`: sağlayıcı kabul etti;
 * - `INVALID_RECIPIENT`: numara/adres geçersiz — kullanıcının iletişim bilgisi **silinmez**
 *   (hesabın kimliğidir); iş kalıcı olarak başarısız olur;
 * - `TRANSIENT`: kota/5xx/ağ — geri çekilip tekrar denenir;
 * - `PERMANENT`: istek/yapılandırma hatası.
 */
export type MessageOutcome = 'SENT' | 'INVALID_RECIPIENT' | 'TRANSIENT' | 'PERMANENT';

/**
 * Gerçek sağlayıcı henüz seçilmedi: yalnız mock vardır; dağıtılan ortamlarda kanal `disabled`
 * olmak zorundadır (env şeması). Sağlayıcı seçilince bu portun arkasına adapter eklenir.
 * TODO(legal): İYS / 6563 — işlemsel (bilgilendirme) iletisi sınıflandırması, e-posta için
 * aydınlatma; sağlayıcı sözleşmesi (yurt içi veri işleme).
 *
 * Sözleşme: gerçek adapter her çağrıyı **≤ 10 sn** zaman aşımıyla sınırlar ve alıcı adresini
 * loglamaz. Worker'ın tur bütçesi (kira 120 sn) bu sınıra dayanır.
 */
export interface SmsSender {
  send(phoneE164: string, content: SmsContent): Promise<MessageOutcome>;
}

export interface EmailSender {
  send(email: string, content: EmailContent): Promise<MessageOutcome>;
}

/** Yerel/test: gönderilmez, yalnız loglanır. Numara loglanmaz. */
@Injectable()
export class MockSmsSender implements SmsSender {
  readonly sent: { content: SmsContent }[] = [];

  constructor(@Inject(ROOT_LOGGER) private readonly logger: Logger) {}

  async send(_phoneE164: string, content: SmsContent): Promise<MessageOutcome> {
    this.sent.push({ content });
    this.logger.info({ sms: { length: content.text.length } }, 'SMS (mock)');
    return 'SENT';
  }
}

/** Yerel/test: gönderilmez, yalnız loglanır. Adres loglanmaz. */
@Injectable()
export class MockEmailSender implements EmailSender {
  readonly sent: { content: EmailContent }[] = [];

  constructor(@Inject(ROOT_LOGGER) private readonly logger: Logger) {}

  async send(_email: string, content: EmailContent): Promise<MessageOutcome> {
    this.sent.push({ content });
    this.logger.info({ email: { subject: content.subject } }, 'E-posta (mock)');
    return 'SENT';
  }
}
