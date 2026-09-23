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
import { BigQueryExportService } from './bigquery-export.service';
import {
  AnalyticsExportStatusResponseDto,
  ReconciliationDiscrepancyListResponseDto,
  ReconciliationDiscrepancyQueryDto,
  ReconciliationDiscrepancyResponseDto,
  ReconciliationRunResponseDto,
} from './dto/analytics.dto';
import { ReconciliationService } from './reconciliation.service';

/**
 * Analitik ve mutabakat operasyonları (Faz 11, ADR-0021).
 *
 * `SUPPORT` triyaj için okur; manuel mutabakat turu tetikleme ve bulgu kapatma
 * yalnızca `ADMIN`'e açıktır — `ops.controller.ts` ile aynı desen.
 */
@Controller('analytics')
@Roles('ADMIN', 'SUPPORT')
export class AnalyticsController {
  constructor(
    private readonly exportService: BigQueryExportService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  @Get('export/status')
  async exportStatus(): Promise<AnalyticsExportStatusResponseDto> {
    const status = await this.exportService.status();
    return {
      unexportedCount: status.unexportedCount,
      oldestUnexportedAgeMs: status.oldestUnexportedAgeMs,
      lastExportedAt: status.lastExportedAt?.toISOString() ?? null,
    };
  }

  @Get('reconciliation')
  async listDiscrepancies(
    @Query() query: ReconciliationDiscrepancyQueryDto,
  ): Promise<ReconciliationDiscrepancyListResponseDto> {
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const rows = await this.reconciliation.list({
      ...(query.resolved !== undefined ? { resolved: query.resolved === 'true' } : {}),
      ...(query.discrepancyType !== undefined ? { discrepancyType: query.discrepancyType } : {}),
      limit: limit + 1,
      ...(cursor !== null ? { before: { detectedAt: cursor.createdAt, id: cursor.id } } : {}),
    });
    const page = paginate(rows, limit, (row) => ({ createdAt: row.detectedAt, id: row.id }));
    return {
      items: page.items.map(ReconciliationDiscrepancyResponseDto.from),
      nextCursor: page.nextCursor,
    };
  }

  @Post('reconciliation/run')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  async runReconciliation(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReconciliationRunResponseDto> {
    const summary = await this.reconciliation.run('MANUAL', user.id);
    return ReconciliationRunResponseDto.from(summary);
  }

  @Post('reconciliation/:id/resolve')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  async resolveDiscrepancy(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ resolved: true }> {
    await this.reconciliation.resolve(String(id), user.id);
    return { resolved: true };
  }
}
