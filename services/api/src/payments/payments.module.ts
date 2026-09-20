import { Module } from '@nestjs/common';
import { BookingStateModule } from '../bookings/state/booking-state.module';
import { AppConfigService } from '../common/config/app-config.service';
import { MockPaymentProvider } from './mock-payment-provider';
import { PAYMENT_PROVIDER, type PaymentProvider } from './payment-provider.port';
import { PaymentsController } from './payments.controller';
import { PaymentsRepository } from './payments.repository';
import { PaymentsService } from './payments.service';

@Module({
  imports: [BookingStateModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    PaymentsRepository,
    MockPaymentProvider,
    {
      provide: PAYMENT_PROVIDER,
      inject: [AppConfigService, MockPaymentProvider],
      useFactory: (config: AppConfigService, mock: MockPaymentProvider): PaymentProvider => {
        if (config.env.PAYMENT_PROVIDER === 'mock') {
          return mock;
        }
        // Lisanslı sağlayıcı adapter'ı, sözleşme ve şartlı ödeme yeteneği doğrulandığında
        // eklenecek (risk R-02). Config production'da mock'u zaten reddeder.
        throw new Error(
          `PAYMENT_PROVIDER=${config.env.PAYMENT_PROVIDER} için adapter henüz uygulanmadı`,
        );
      },
    },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
