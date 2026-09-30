import { Module } from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { EMAIL_SENDER, MockEmailSender, MockSmsSender, SMS_SENDER } from './message-senders';
import { NotificationDeliveryWorker } from './notification-delivery.worker';
import { FcmPushSender, MockPushSender, PUSH_SENDER } from './push-sender';

/** Bildirimler (Faz 16, R-77): cihaz token'ları, push/SMS/e-posta göndericileri, teslimat worker'ı. */
@Module({
  controllers: [DevicesController],
  providers: [
    DevicesService,
    MockPushSender,
    FcmPushSender,
    {
      provide: PUSH_SENDER,
      inject: [AppConfigService, MockPushSender, FcmPushSender],
      useFactory: (config: AppConfigService, mock: MockPushSender, fcm: FcmPushSender) =>
        config.env.PUSH_PROVIDER === 'fcm' ? fcm : mock,
    },
    // SMS / e-posta (R-77): gerçek sağlayıcı seçilene dek yalnız mock; `disabled` kanala iş
    // üretilmediği için dağıtılan ortamda mock'a hiç iş düşmez.
    MockSmsSender,
    MockEmailSender,
    { provide: SMS_SENDER, useExisting: MockSmsSender },
    { provide: EMAIL_SENDER, useExisting: MockEmailSender },
    NotificationDeliveryWorker,
  ],
  exports: [NotificationDeliveryWorker, PUSH_SENDER, SMS_SENDER, EMAIL_SENDER],
})
export class NotificationsModule {}
