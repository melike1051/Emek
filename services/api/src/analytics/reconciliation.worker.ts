import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Logger } from 'pino';
import { ROOT_LOGGER } from '../common/logging/logging.tokens';
import { AppConfigService } from '../common/config/app-config.service';
import { ReconciliationService } from './reconciliation.service';

/**
 * Zamanlanmış ödeme mutabakat worker'ı (Faz 11, ADR-0021).
 *
 * `ScheduledReleaseWorker`/`BigQueryExportWorker` ile aynı desen. Başlatma koşulu:
 * `RECONCILIATION_ENABLED=true` (varsayılan `false`).
 */
@Injectable()
export class ReconciliationWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private readonly enabled: boolean;
  private readonly intervalMs: number;

  constructor(
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    private readonly config: AppConfigService,
    private readonly reconciliation: ReconciliationService,
  ) {
    this.enabled = config.env.RECONCILIATION_ENABLED;
    this.intervalMs = config.env.RECONCILIATION_INTERVAL_MS;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.info('Mutabakat worker devre dışı (RECONCILIATION_ENABLED=false)');
      return;
    }
    this.logger.info({ intervalMs: this.intervalMs }, 'Mutabakat worker başlatılıyor');
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
          this.logger.error({ err: error }, 'Mutabakat turu beklenmeyen hatayla düştü');
        })
        .finally(() => this.schedule());
    }, this.intervalMs);
    this.timer.unref();
  }

  /** Tek bir mutabakat turu. Testler bunu doğrudan çağırabilir. */
  async tick(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      const summary = await this.reconciliation.run('SCHEDULED');
      return summary.newDiscrepancyCount;
    } finally {
      this.running = false;
    }
  }
}
