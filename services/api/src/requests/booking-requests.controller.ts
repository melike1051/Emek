import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../auth/auth.decorators';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { RateLimit } from '../common/ratelimit/rate-limit.decorator';
import { BookingRequestsService } from './booking-requests.service';
import {
  BookingRequestResponseDto,
  CreateFromTextResponseDto,
  CreateRequestFromFormDto,
  CreateRequestFromTextDto,
} from './dto/booking-request.dto';

@Controller('booking-requests')
export class BookingRequestsController {
  constructor(private readonly requests: BookingRequestsService) {}

  /**
   * Serbest metinden talep.
   *
   * NLP erişilemezse istek **başarısız olmaz**: `FORM_REQUIRED` döner ve istemci
   * yapılandırılmış formu açar (T-15).
   */
  @Post('from-text')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'request-from-text', limit: 20, windowSeconds: 60 })
  async fromText(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateRequestFromTextDto,
  ): Promise<CreateFromTextResponseDto> {
    const outcome = await this.requests.createFromText({
      customerId: user.id,
      rawText: dto.rawText,
      addressId: dto.addressId,
    });

    return CreateFromTextResponseDto.from(outcome);
  }

  /** Yapılandırılmış form yolu; AI servisine hiç dokunmaz. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'request-from-form', limit: 30, windowSeconds: 60 })
  async fromForm(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateRequestFromFormDto,
  ): Promise<BookingRequestResponseDto> {
    const record = await this.requests.createFromForm({
      customerId: user.id,
      serviceId: dto.serviceId,
      addressId: dto.addressId,
      preferredStart: dto.preferredStart,
      preferredEnd: dto.preferredEnd,
      durationMinutes: dto.durationMinutes,
    });

    return BookingRequestResponseDto.from(record);
  }

  @Get(':id')
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BookingRequestResponseDto> {
    const record = await this.requests.findOwned(id, user.id);
    if (record === null) {
      // Sahibi olmayan kullanıcıya talebin varlığı bildirilmez.
      throw new BusinessException(ErrorCode.NOT_FOUND);
    }
    return BookingRequestResponseDto.from(record);
  }
}
