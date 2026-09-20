import { Module } from '@nestjs/common';
import { BookingStateService } from './booking-state.service';

/**
 * Booking durum geçişi ayrı bir modüldedir.
 *
 * Gerekçe: ödeme akışı da booking durumunu ilerletir (yetkilendirme alındığında
 * `PAYMENT_AUTHORIZED` → `SCHEDULED`), booking akışı da ödeme durumunu ilerletir
 * (hizmet tamamlandığında `SERVICE_COMPLETED`). İkisi birbirinin modülünü import
 * etseydi döngü oluşurdu. Geçiş motorunu paylaşılan bir modüle almak, geçişin
 * **tek yol** olma özelliğini bozmadan bu döngüyü keser.
 */
@Module({
  providers: [BookingStateService],
  exports: [BookingStateService],
})
export class BookingStateModule {}
