import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Logger } from 'pino';
import { ROOT_LOGGER } from '../common/logging/logging.tokens';
import { AppConfigService } from '../common/config/app-config.service';
import { BigQueryExportService } from './bigquery-export.service';

/**
 * Zamanlanmış BigQuery export worker'ı (Faz 11, ADR-0021).
 *
 * `ScheduledReleaseWorker` ile aynı desen (R-42). Başlatma koşulu:
 * `ANALYTICS_EXPORT_ENABLED=true` (varsayılan `false`) — kapalıyken hiçbir
 * transactional davranış etkilenmez, `analytics_events` yalnızca birikir.
 */
@Injectable()
export class BigQueryExportWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private readonly enabled: boolean;
  private readonly intervalMs: number;

  constructor(
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    private readonly config: AppConfigService,
    private readonly exportService: BigQueryExportService,
  ) {
    this.enabled = config.env.ANALYTICS_EXPORT_ENABLED;
    this.intervalMs = config.env.ANALYTICS_EXPORT_INTERVAL_MS;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.info('BigQuery export worker devre dışı (ANALYTICS_EXPORT_ENABLED=false)');
      return;
    }
    this.logger.info({ intervalMs: this.intervalMs }, 'BigQuery export worker başlatılıyor');
    this.schedule();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
  }

  private schedule(): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.tick()
        .catch((error: unknown) => {
          this.logger.error({ err: error }, 'BigQuery export turu beklenmeyen hatayla düştü');
        })
        .finally(() => this.schedule());
    }, this.intervalMs);
    this.timer.unref();
  }

  /** Tek bir export turu. Testler bunu doğrudan çağırabilir. */
  async tick(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      return await this.exportService.exportBatch();
    } finally {
      this.running = false;
    }
  }
}
