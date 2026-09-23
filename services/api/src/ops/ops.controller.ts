import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser, Roles, type AuthenticatedUser } from '../auth/auth.decorators';
import { clampLimit, decodeCursor, paginate } from '../common/pagination/cursor';
import {
  DeadLetterListResponseDto,
  DeadLetterQueryDto,
  DeadLetterResponseDto,
  NotificationJobListResponseDto,
  NotificationJobQueryDto,
  NotificationJobResponseDto,
  OpsHealthResponseDto,
} from './dto/ops.dto';
import { OpsService } from './ops.service';

/**
 * Sistem sağlığı ve asenkron kuyruk operasyonları (Faz 10).
 *
 * `SUPPORT` triyaj için okur; kayıt kapatma/yeniden kuyruklama yalnızca `ADMIN`'e
 * açıktır (ADR-0013 §4 — safety operatör uçlarıyla aynı desen).
 */
@Controller('ops')
@Roles('ADMIN', 'SUPPORT')
export class OpsController {
  constructor(private readonly ops: OpsService) {}

  @Get('health')
  async health(): Promise<OpsHealthResponseDto> {
    const summary = await this.ops.health();
    return OpsHealthResponseDto.from(summary);
  }

  @Get('dead-letter')
  async listDeadLetters(@Query() query: DeadLetterQueryDto): Promise<DeadLetterListResponseDto> {
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const rows = await this.ops.listDeadLetters({
      ...(query.consumer !== undefined ? { consumer: query.consumer } : {}),
      ...(query.resolved !== undefined ? { resolved: query.resolved === 'true' } : {}),
      limit: limit + 1,
      ...(cursor !== null ? { before: cursor } : {}),
    });
    const page = paginate(rows, limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
    return { items: page.items.map(DeadLetterResponseDto.from), nextCursor: page.nextCursor };
  }

  @Post('dead-letter/:id/resolve')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  async resolveDeadLetter(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ resolved: true }> {
    await this.ops.resolveDeadLetter(String(id), user.id);
    return { resolved: true };
  }

  @Get('notification-jobs')
  async listNotificationJobs(
    @Query() query: NotificationJobQueryDto,
  ): Promise<NotificationJobListResponseDto> {
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const rows = await this.ops.listNotificationJobs({
      ...(query.status !== undefined ? { status: query.status } : {}),
      limit: limit + 1,
      ...(cursor !== null ? { before: cursor } : {}),
    });
    const page = paginate(rows, limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
    return { items: page.items.map(NotificationJobResponseDto.from), nextCursor: page.nextCursor };
  }

  @Post('notification-jobs/:id/retry')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  async retryNotificationJob(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ retried: true }> {
    await this.ops.retryNotificationJob(String(id), user.id);
    return { retried: true };
  }
}
