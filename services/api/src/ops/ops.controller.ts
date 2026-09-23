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
import { AuditVerificationService } from '../common/audit/audit-verification.service';
import { RetentionService } from '../common/retention/retention.service';
import { clampLimit, decodeCursor, paginate } from '../common/pagination/cursor';
import {
  AuditChainStatusResponseDto,
  DeadLetterListResponseDto,
  DeadLetterQueryDto,
  DeadLetterResponseDto,
  NotificationJobListResponseDto,
  NotificationJobQueryDto,
  NotificationJobResponseDto,
  OpsHealthResponseDto,
  RetentionSweepResponseDto,
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
  constructor(
    private readonly ops: OpsService,
    private readonly auditVerification: AuditVerificationService,
    private readonly retention: RetentionService,
  ) {}

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

  /**
   * Audit hash zincirinin son doğrulama durumu.
   *
   * Okuma işlemidir ve zinciri **değiştirmez**; `SUPPORT` de görebilir çünkü
   * triyajın ilk sorusu "denetim izi sağlam mı" olabilir.
   */
  @Get('audit-chain')
  async auditChainStatus(): Promise<AuditChainStatusResponseDto> {
    const checkpoint = await this.auditVerification.latestCheckpoint();
    return {
      status: checkpoint === null ? 'OK' : (checkpoint.status as 'OK' | 'BROKEN'),
      rowsVerified: 0,
      verifiedThroughId: checkpoint?.verified_through_id ?? null,
      brokenAtId: checkpoint?.status === 'BROKEN' ? checkpoint.verified_through_id : null,
      exportedStorageKey: null,
    };
  }

  /**
   * Doğrulamayı elle tetikler (olay müdahalesi).
   *
   * `ADMIN`'e kısıtlıdır: iş yükü üretir ve checkpoint yazar. Doğrulama hiçbir
   * audit satırını değiştirmez — yalnızca `audit_chain_checkpoints`'a ekler.
   */
  @Post('audit-chain/verify')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  async verifyAuditChain(): Promise<AuditChainStatusResponseDto> {
    const result = await this.auditVerification.verifyOnce();
    return result;
  }

  /**
   * Retention taramasını elle tetikler.
   *
   * `ADMIN`'e kısıtlıdır: **veri siler**. `SUPPORT` yıkıcı işlem yapamaz
   * (ADR-0013 §4).
   */
  @Post('retention/sweep')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  async sweepRetention(): Promise<RetentionSweepResponseDto> {
    return this.retention.sweep();
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
