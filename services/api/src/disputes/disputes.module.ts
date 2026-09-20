import { Module } from '@nestjs/common';
import { BookingStateModule } from '../bookings/state/booking-state.module';
import { PaymentsModule } from '../payments/payments.module';
import { DisputesController } from './disputes.controller';
import { DisputesService } from './disputes.service';

@Module({
  imports: [PaymentsModule, BookingStateModule],
  controllers: [DisputesController],
  providers: [DisputesService],
  exports: [DisputesService],
})
export class DisputesModule {}
