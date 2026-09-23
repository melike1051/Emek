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
import { clampLimit, decodeCursor, paginate } from '../common/pagination/cursor';
import { RateLimit } from '../common/ratelimit/rate-limit.decorator';
import { UserRateLimit } from '../common/ratelimit/user-rate-limit.decorator';
import { DisputesService } from './disputes.service';
import {
  AdminDisputeListResponseDto,
  AdminDisputeQueryDto,
  DisputeResponseDto,
  OpenDisputeDto,
  ResolveDisputeDto,
} from './dto/dispute.dto';

@Controller()
export class DisputesController {
  constructor(private readonly disputes: DisputesService) {}

  /** Admin izleme kuyruğu. Sahiplik kapısı yoktur — operasyon triyajı. */
  @Get('disputes/admin')
  @Roles('ADMIN', 'SUPPORT')
  async adminList(@Query() query: AdminDisputeQueryDto): Promise<AdminDisputeListResponseDto> {
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const rows = await this.disputes.listForAdmin({
      ...(query.status !== undefined ? { status: query.status } : {}),
      limit: limit + 1,
      ...(cursor !== null ? { before: cursor } : {}),
    });
    const page = paginate(rows, limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
    return { items: page.items.map(DisputeResponseDto.from), nextCursor: page.nextCursor };
  }

  /** Uyuşmazlık açmak taraflara açıktır. */
  @Post('bookings/:id/disputes')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'dispute-open', limit: 10, windowSeconds: 60 })
  @UserRateLimit({ name: 'dispute-open', limit: 10, windowSeconds: 3600 })
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
