import { Module } from '@nestjs/common';
import { SafetyCoreModule } from '../../safety/safety-core.module';
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
  // Güvenlik oturumu booking geçişiyle aynı transaction'da ilerler (ADR-0019 §2).
  // `SafetyCoreModule` booking modüllerini import etmez; döngü oluşmaz.
  imports: [SafetyCoreModule],
  providers: [BookingStateService],
  exports: [BookingStateService],
})
export class BookingStateModule {}
