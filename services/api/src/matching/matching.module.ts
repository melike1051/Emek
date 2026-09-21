import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { BookingStateModule } from '../bookings/state/booking-state.module';
import { BookingRequestsModule } from '../requests/booking-requests.module';
import { HttpMatchingClient } from './http-matching.client';
import { MatchingController } from './matching.controller';
import { MATCHING_CLIENT } from './matching.port';
import { MatchingRepository } from './matching.repository';
import { MatchingService } from './matching.service';

/**
 * Eşleştirme modülü.
 *
 * NLP modülüyle aynı ilke: **mock istemci yoktur**. "Karar motoru down" senaryosu
 * testlerde gerçek istemcinin erişilemeyen bir adrese bağlanmasıyla kurulur, çünkü
 * ölçülmek istenen tam olarak o yoldur (Faz 6 review bulgusu M3).
 */
@Module({
  imports: [BookingsModule, BookingStateModule, BookingRequestsModule],
  controllers: [MatchingController],
  providers: [
    MatchingService,
    MatchingRepository,
    HttpMatchingClient,
    { provide: MATCHING_CLIENT, useExisting: HttpMatchingClient },
  ],
  exports: [MatchingService, MatchingRepository],
})
export class MatchingModule {}
