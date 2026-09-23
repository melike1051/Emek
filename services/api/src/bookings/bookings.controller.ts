import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser, Roles, type AuthenticatedUser } from '../auth/auth.decorators';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { clampLimit, decodeCursor, paginate } from '../common/pagination/cursor';
import { RateLimit } from '../common/ratelimit/rate-limit.decorator';
import { BookingsService } from './bookings.service';
import {
  AdminBookingListResponseDto,
  AdminBookingQueryDto,
  BookingHistoryResponseDto,
  BookingResponseDto,
  CancelBookingDto,
  CreateBookingDto,
  TransitionBookingDto,
} from './dto/booking.dto';

@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'booking-create', limit: 30, windowSeconds: 60 })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBookingDto,
  ): Promise<BookingResponseDto> {
    const booking = await this.bookings.create({
      customerId: user.id,
      providerId: dto.providerId,
      serviceId: dto.serviceId,
      addressId: dto.addressId,
      scheduledStart: dto.scheduledStart,
      scheduledEnd: dto.scheduledEnd,
    });

    return BookingResponseDto.from(booking);
  }

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser): Promise<BookingResponseDto[]> {
    const bookings = await this.bookings.listForUser(user.id);
    return bookings.map(BookingResponseDto.from);
  }

  /**
   * Admin izleme listesi. `:id` rotasından **önce** tanımlanmalı: aksi halde
   * `/bookings/admin` isteği `:id = "admin"` olarak yakalanır.
   */
  @Get('admin')
  @Roles('ADMIN', 'SUPPORT')
  async adminList(@Query() query: AdminBookingQueryDto): Promise<AdminBookingListResponseDto> {
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const rows = await this.bookings.listForAdmin({
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.customerId !== undefined ? { customerId: query.customerId } : {}),
      ...(query.providerId !== undefined ? { providerId: query.providerId } : {}),
      limit: limit + 1,
      ...(cursor !== null ? { before: cursor } : {}),
    });
    const page = paginate(rows, limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
    return { items: page.items.map(BookingResponseDto.from), nextCursor: page.nextCursor };
  }

  @Get(':id')
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BookingResponseDto> {
    const booking = await this.bookings.findForParticipant(id, user.id);
    if (booking === null) {
      // Taraf olmayan kullanıcıya rezervasyonun varlığı bile bildirilmez.
      throw new BusinessException(ErrorCode.NOT_FOUND);
    }
    return BookingResponseDto.from(booking);
  }

  @Get(':id/history')
  async history(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BookingHistoryResponseDto[]> {
    const entries = await this.bookings.history(id, user.id);
    if (entries.length === 0) {
      throw new BusinessException(ErrorCode.NOT_FOUND);
    }
    return entries.map(BookingHistoryResponseDto.from);
  }

  /** Sağlayıcı onayı: `PROVIDER_PENDING → CONFIRMED`. */
  @Post(':id/confirm')
  async confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BookingResponseDto> {
    const booking = await this.bookings.transition({
      bookingId: id,
      to: 'CONFIRMED',
      userId: user.id,
      roles: user.roles,
    });
    return BookingResponseDto.from(booking);
  }

  @Post(':id/cancel')
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelBookingDto,
  ): Promise<BookingResponseDto> {
    const booking = await this.bookings.transition({
      bookingId: id,
      to: 'CANCELLED',
      userId: user.id,
      roles: user.roles,
      ...(dto.reason !== undefined ? { reason: dto.reason } : {}),
    });
    return BookingResponseDto.from(booking);
  }

  /**
   * Hizmet günü akışı tek endpoint üzerinden ilerletilir; hangi geçişlerin geçerli
   * olduğunu transition map belirler (ADR-0006). Ayrı ayrı endpoint yazmak, geçiş
   * kurallarını yeniden HTTP katmanına dağıtmak olurdu.
   */
  @Post(':id/transitions')
  async transition(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionBookingDto,
  ): Promise<BookingResponseDto> {
    const booking = await this.bookings.transition({
      bookingId: id,
      to: dto.to,
      userId: user.id,
      roles: user.roles,
    });
    return BookingResponseDto.from(booking);
  }
}
