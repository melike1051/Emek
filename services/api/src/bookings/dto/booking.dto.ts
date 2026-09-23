import { Type } from 'class-transformer';
import { IsDate, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CursorQueryDto } from '../../common/pagination/cursor-query.dto';
import { BOOKING_STATUSES, type BookingStatus } from '../state/booking-status';
import type { Booking, BookingHistoryEntry } from '../bookings.service';

export class CreateBookingDto {
  @IsUUID()
  providerId!: string;

  @IsUUID()
  serviceId!: string;

  @IsUUID()
  addressId!: string;

  @Type(() => Date)
  @IsDate()
  scheduledStart!: Date;

  @Type(() => Date)
  @IsDate()
  scheduledEnd!: Date;

  // Fiyat **istemciden alınmaz**: katalogdan sunucuda hesaplanır (Faz 4 review bulgusu).
}

/** İptal dışındaki geçişler gövdesizdir; iptal gerekçe alır. */
export class CancelBookingDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  reason?: string;
}

export class TransitionBookingDto {
  @IsIn(['PROVIDER_ARRIVING', 'CHECKED_IN', 'IN_PROGRESS', 'CHECKED_OUT', 'CUSTOMER_CONFIRMED'])
  to!: 'PROVIDER_ARRIVING' | 'CHECKED_IN' | 'IN_PROGRESS' | 'CHECKED_OUT' | 'CUSTOMER_CONFIRMED';
}

export class BookingResponseDto {
  id!: string;
  customerId!: string;
  providerId!: string | null;
  serviceId!: string;
  addressId!: string;
  scheduledStart!: string;
  scheduledEnd!: string;
  priceMinor!: string;
  currency!: string;
  status!: string;

  static from(booking: Booking): BookingResponseDto {
    return {
      id: booking.id,
      customerId: booking.customerId,
      providerId: booking.providerId,
      serviceId: booking.serviceId,
      addressId: booking.addressId,
      scheduledStart: booking.scheduledStart.toISOString(),
      scheduledEnd: booking.scheduledEnd.toISOString(),
      priceMinor: booking.priceMinor,
      currency: booking.currency,
      status: booking.status,
    };
  }
}

export class BookingHistoryResponseDto {
  fromStatus!: string | null;
  toStatus!: string;
  reason!: string | null;
  createdAt!: string;

  static from(entry: BookingHistoryEntry): BookingHistoryResponseDto {
    return {
      fromStatus: entry.fromStatus,
      toStatus: entry.toStatus,
      reason: entry.reason,
      createdAt: entry.createdAt.toISOString(),
    };
  }
}

// --- Admin: rezervasyon izleme (Faz 10) ---

export class AdminBookingQueryDto extends CursorQueryDto {
  @IsOptional()
  @IsIn(BOOKING_STATUSES)
  status?: BookingStatus;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsUUID()
  providerId?: string;
}

export class AdminBookingListResponseDto {
  items!: BookingResponseDto[];
  nextCursor!: string | null;
}
