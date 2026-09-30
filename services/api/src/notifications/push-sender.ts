import { Inject, Injectable } from '@nestjs/common';
import { GoogleAuth } from 'google-auth-library';
import type { Logger } from 'pino';
import { AppConfigService } from '../common/config/app-config.service';
import { ROOT_LOGGER } from '../common/logging/logging.tokens';
import type { PushContent } from './push-templates';

export const PUSH_SENDER = Symbol('PUSH_SENDER');

/**
 * Tek cihaza gönderimin sonucu:
 * - `SENT`: sağlayıcı kabul etti;
 * - `INVALID_TOKEN`: token artık geçersiz (uygulama silindi/yenilendi) — cihaz kaydı silinir;
 * - `TRANSIENT`: kota/5xx/ağ — iş geri çekilip tekrar denenir;
 * - `PERMANENT`: istek hatalı (yapılandırma/izin) — tekrar denemek düzeltmez.
 */
export type PushOutcome = 'SENT' | 'INVALID_TOKEN' | 'TRANSIENT' | 'PERMANENT';

export interface PushSender {
  send(token: string, content: PushContent): Promise<PushOutcome>;
}

/** Yerel/test: gönderilmez, yalnız loglanır. Token loglanmaz. */
@Injectable()
export class MockPushSender implements PushSender {
  readonly sent: { content: PushContent }[] = [];

  constructor(@Inject(ROOT_LOGGER) private readonly logger: Logger) {}

  async send(_token: string, content: PushContent): Promise<PushOutcome> {
    this.sent.push({ content });
    this.logger.info({ push: { title: content.title, route: content.route } }, 'Push (mock)');
    return 'SENT';
  }
}

/**
 * FCM HTTP v1 (`projects/{id}/messages:send`). Kimlik: Cloud Run servis hesabının ADC'si
 * (`roles/firebasecloudmessaging.admin`), anahtar dosyası yok. Bildirim metni PII içermez;
 * `data.route` uygulamanın açacağı ekrandır.
 */
@Injectable()
export class FcmPushSender implements PushSender {
  private readonly auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
  });
  private readonly endpoint: string;

  constructor(
    config: AppConfigService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {
    this.endpoint = `https://fcm.googleapis.com/v1/projects/${config.env.FIREBASE_PROJECT_ID}/messages:send`;
  }

  async send(token: string, content: PushContent): Promise<PushOutcome> {
    let status: number;
    let errorCode: string | undefined;
    try {
      const client = await this.auth.getClient();
      const response = await client.request<{ error?: { details?: { errorCode?: string }[] } }>({
        url: this.endpoint,
        method: 'POST',
        timeout: 10_000,
        validateStatus: () => true,
        data: {
          message: {
            token,
            notification: { title: content.title, body: content.body },
            data: { route: content.route },
            android: { priority: 'HIGH' },
          },
        },
      });
      status = response.status;
      errorCode = response.data?.error?.details?.find((d) => d.errorCode)?.errorCode;
    } catch (error) {
      this.logger.warn({ err: error instanceof Error ? error.message : error }, 'FCM erişilemedi');
      return 'TRANSIENT';
    }
    return classifyFcm(status, errorCode);
  }
}

/** FCM v1 hata sınıflandırması (saf, testli). */
export function classifyFcm(status: number, errorCode: string | undefined): PushOutcome {
  if (status >= 200 && status < 300) return 'SENT';
  if (errorCode === 'UNREGISTERED' || (status === 404 && errorCode === undefined)) {
    return 'INVALID_TOKEN';
  }
  // INVALID_ARGUMENT bilinçli olarak token hatası sayılmaz: FCM bunu bozuk yük için de döner;
  // şablon hatası her alıcının cihaz kaydını toplu silerdi. Kalıcı ret olarak kalır.
  if (status === 429 || status >= 500 || errorCode === 'UNAVAILABLE' || errorCode === 'INTERNAL') {
    return 'TRANSIENT';
  }
  return 'PERMANENT';
}
