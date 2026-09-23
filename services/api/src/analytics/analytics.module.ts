import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { bigQueryPortProvider } from './bigquery-client.provider';
import { BigQueryExportService } from './bigquery-export.service';
import { BigQueryExportWorker } from './bigquery-export.worker';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationWorker } from './reconciliation.worker';

/**
 * BigQuery export + ödeme mutabakatı (Faz 11, ADR-0021).
 *
 * `AuditModule`/`DatabaseModule` Global'dır, burada ayrıca import edilmez
 * (`ops.module.ts` ile aynı not).
 */
@Module({
  controllers: [AnalyticsController],
  providers: [
    bigQueryPortProvider,
    BigQueryExportService,
    BigQueryExportWorker,
    ReconciliationService,
    ReconciliationWorker,
  ],
})
export class AnalyticsModule {}
