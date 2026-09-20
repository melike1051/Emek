import { Module } from '@nestjs/common';
import { AddressesModule } from '../addresses/addresses.module';
import { CatalogModule } from '../catalog/catalog.module';
import { PaymentsModule } from '../payments/payments.module';
import { ProvidersModule } from '../providers/providers.module';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { BookingStateModule } from './state/booking-state.module';

@Module({
  // `PaymentsModule` tek yönlü import edilir: booking akışı ödeme durumunu ilerletir
  // (hizmet tamamlandı), ödeme akışı booking durumunu paylaşılan `BookingStateModule`
  // üzerinden ilerletir. Böylece modül döngüsü oluşmaz.
  imports: [AddressesModule, ProvidersModule, CatalogModule, PaymentsModule, BookingStateModule],
  controllers: [BookingsController],
  providers: [BookingsService],
  exports: [BookingsService],
})
export class BookingsModule {}
