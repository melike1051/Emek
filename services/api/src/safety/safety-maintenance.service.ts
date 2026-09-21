import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Logger } from 'pino';
import { AuditAction, AuditService } from '../common/audit/audit.service';
import { AppConfigService } from '../common/config/app-config.service';
import { UnitOfWork } from '../common/database/unit-of-work';
import { BusinessException } from '../common/errors/business.exception';
import { ROOT_LOGGER } from '../common/logging/logging.tokens';
import { SafetyEvaluationService } from './safety-evaluation.service';
import { SafetyLifecycleService } from './safety-lifecycle.service';
import { SafetyMetrics } from './safety-metrics';
import { SafetyRepository } from './safety.repository';

/**
 * Planlanan bitişten bu kadar saat sonra hâlâ açık (ve düşük riskli) oturumlar
 * `EXPIRED` ile kapanır. Uzun tutulur: hizmet uzayabilir ve erken kapanış
 * izlemeyi keser. Yüksek riskli oturumlar kendiliğinden hiç kapanmaz.
 */
export const SESSION_EXPIRY_GRACE_HOURS = 12;
const EXPIRY_BATCH_LIMIT = 50;
const RETENTION_BATCH_LIMIT = 100;

export interface MaintenanceResult {
  expiredSessions: number;
  purgedSessions: number;
  purgedLocationRows: number;
  partitions: (string | null)[];
}

/**
 * Safety bakım işleri ve arka plan izleyicisi.
 *
 * Üç iş, üç gerekçe:
 *
 * 1. **Zamanlanmış değerlendirme.** Telemetri kesildiğinde ingest de durur; boşluğu
 *    fark edecek olan şey veri değil, zamandır. İzleyici olmasaydı "telefon sustu"
 *    durumu (tam da yakalanması gereken şey) hiç değerlendirilmezdi.
 * 2. **Süre aşımı.** Hiç ilerlemeyen bir rezervasyonun oturumu sonsuza dek açık
 *    kalmamalı; açık oturum, telemetri kapısının açık kalması demektir.
 * 3. **Retention.** Ham konumun son kullanma tarihi bir politika metni değil, bir
 *    silme işidir (ADR-0008 §5, T-24).
 *
 * Çok instance'lı çalışmada güvenlidir: değerlendirme sahiplenmesi ve retention
 * `SKIP LOCKED` kullanır; süre aşımı, oturum kilidi altında durumu yeniden okur.
 */
@Injectable()
export class SafetyMaintenanceService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly repository: SafetyRepository,
    private readonly lifecycle: SafetyLifecycleService,
    private readonly evaluation: SafetyEvaluationService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly metrics: SafetyMetrics,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    // Partition'lar izleyiciden bağımsız hazırlanır: izleyici kapalıyken de gelen
    // örnekler DEFAULT'a düşmemeli (Faz 8 review). Hata açılışı engellemez.
    void this.guard('partitions', async () => {
      const now = new Date();
      await this.repository.ensureLocationPartition(now);
      await this.repository.ensureLocationPartition(
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
      );
    });
    if (!this.config.env.SAFETY_MONITOR_ENABLED) {
      return;
    }
    this.schedule();
  }

  onApplicationShutdown(): void {
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
      void this.tick().finally(() => this.schedule());
    }, this.config.env.SAFETY_MONITOR_INTERVAL_SECONDS * 1000);
    this.timer.unref();
  }

  /** Bir izleyici turu. Adımlar birbirinden yalıtılır: biri düşerse diğerleri çalışır. */
  async tick(): Promise<void> {
    await this.guard('evaluation', () => this.evaluation.evaluateDue());
    await this.guard('maintenance', () => this.runMaintenance());
  }

  async runMaintenance(now: Date = new Date()): Promise<MaintenanceResult> {
    const expiredSessions = await this.expireStaleSessions();
    const purge = await this.purgeExpiredLocations();

    // Bu ay ve gelecek ay için partition: ay dönümünde kayıtların DEFAULT'a
    // düşmesini önler. DEFAULT'a düşen kayıt kaybolmaz, yalnızca partition
    // düşürmeyle temizlenemez (satır silme ile temizlenir).
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const partitions = [
      await this.repository.ensureLocationPartition(now),
      await this.repository.ensureLocationPartition(next),
    ];

    return {
      expiredSessions,
      purgedSessions: purge.sessions,
      purgedLocationRows: purge.rows,
      partitions,
    };
  }

  async expireStaleSessions(): Promise<number> {
    const ids = await this.repository.findExpiredOpenSessions(
      SESSION_EXPIRY_GRACE_HOURS,
      EXPIRY_BATCH_LIMIT,
    );

    let closed = 0;
    for (const id of ids) {
      try {
        await this.uow.withTransaction(async (client) => {
          const session = await this.repository.lockSession(client, id);
          // Kilit altında yeniden kontrol: arada risk yükselmiş ya da oturum
          // kapanmış olabilir.
          if (
            session === null ||
            session.status === 'CLOSED' ||
            session.riskLevel === 'HIGH_RISK' ||
            session.riskLevel === 'EMERGENCY'
          ) {
            return;
          }
          await this.lifecycle.close(client, id, 'EXPIRED');
          closed += 1;
        });
      } catch (error) {
        if (!(error instanceof BusinessException)) {
          throw error;
        }
      }
    }
    return closed;
  }

  async purgeExpiredLocations(): Promise<{ sessions: number; rows: number }> {
    const outcome = await this.uow.withTransaction(async (client) => {
      const purged = await this.repository.purgeExpiredLocations(client, RETENTION_BATCH_LIMIT);
      if (purged.sessionIds.length > 0) {
        await this.audit.record(client, {
          action: AuditAction.SAFETY_LOCATION_PURGED,
          entityType: 'safety_session',
          newValue: {
            sessionCount: purged.sessionIds.length,
            deletedRows: purged.deletedRows,
            sessionIds: purged.sessionIds,
          },
        });
      }
      return purged;
    });

    if (outcome.sessionIds.length > 0) {
      this.metrics.record('safety.retention.purged', {
        sessions: outcome.sessionIds.length,
        rows: outcome.deletedRows,
      });
    }
    return { sessions: outcome.sessionIds.length, rows: outcome.deletedRows };
  }

  private async guard(step: string, work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.metrics.failure('safety.monitor.failed', { step });
      this.logger.error({ err: error, step }, 'safety izleyici adımı başarısız');
    }
  }
}
