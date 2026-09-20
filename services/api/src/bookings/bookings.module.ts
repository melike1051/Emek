import { Module } from '@nestjs/common';
import { AddressesModule } from '../addresses/addresses.module';
import { CatalogModule } from '../catalog/catalog.module';
import { ProvidersModule } from '../providers/providers.module';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { BookingStateService } from './state/booking-state.service';

@Module({
  imports: [AddressesModule, ProvidersModule, CatalogModule],
  controllers: [BookingsController],
  providers: [BookingsService, BookingStateService],
  exports: [BookingsService, BookingStateService],
})
export class BookingsModule {}
