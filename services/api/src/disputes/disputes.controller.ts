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
import { CurrentUser, Roles, type AuthenticatedUser } from '../auth/auth.decorators';
import { RateLimit } from '../common/ratelimit/rate-limit.decorator';
import { DisputesService } from './disputes.service';
import { DisputeResponseDto, OpenDisputeDto, ResolveDisputeDto } from './dto/dispute.dto';

@Controller()
export class DisputesController {
  constructor(private readonly disputes: DisputesService) {}

  /** Uyuşmazlık açmak taraflara açıktır. */
  @Post('bookings/:id/disputes')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'dispute-open', limit: 10, windowSeconds: 60 })
  async open(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OpenDisputeDto,
  ): Promise<DisputeResponseDto> {
    const dispute = await this.disputes.open({
      bookingId: id,
      userId: user.id,
      reason: dto.reason,
      ...(dto.description !== undefined ? { description: dto.description } : {}),
    });
    return DisputeResponseDto.from(dispute);
  }

  @Get('bookings/:id/disputes')
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DisputeResponseDto[]> {
    const disputes = await this.disputes.listForBooking(id, user.id, user.roles);
    return disputes.map(DisputeResponseDto.from);
  }

  /**
   * Karara bağlama **yalnızca operatöre** açıktır: taraflardan biri kendi lehine
   * karar verebilse uyuşmazlık mekanizması anlamsız olurdu.
   */
  @Post('disputes/:id/resolve')
  @Roles('ADMIN')
  async resolve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveDisputeDto,
  ): Promise<DisputeResponseDto> {
    const dispute = await this.disputes.resolve({
      disputeId: id,
      actorUserId: user.id,
      status: dto.status,
      resolution: dto.resolution,
      ...(dto.refundAmountMinor !== undefined ? { refundAmountMinor: dto.refundAmountMinor } : {}),
    });
    return DisputeResponseDto.from(dispute);
  }
}
