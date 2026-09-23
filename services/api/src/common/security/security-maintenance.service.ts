import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Logger } from 'pino';
import { AuditVerificationService } from '../audit/audit-verification.service';
import { AppConfigService } from '../config/app-config.service';
import { ROOT_LOGGER } from '../logging/logging.tokens';
import { RetentionService } from '../retention/retention.service';

/**
 * Güvenlik bakım işleri (Faz 12).
 *
 * İki iş, iki gerekçe:
 *
 * 1. **Audit zinciri doğrulaması.** Hash zinciri tamper-*evident*'tır: kimse
 *    bakmazsa kopukluk görünmez. Doğrulama bu bakışın kendisidir (T-36).
 * 2. **Retention.** Belgelenmiş saklama süresi, uygulanmayan saklama süresidir.
 *    Silme bir politika metni değil, çalışan bir iştir (T-24, R-38).
 *
 * Safety bakımıyla aynı kalıp: adımlar birbirinden yalıtılır (biri düşerse diğeri
 * çalışır), zamanlayıcı `unref()` edilir ve kapanışta durdurulur. İki iş de
 * `SKIP LOCKED` veya idempotent yazım kullanır; çok instance'lı çalışmada
 * güvenlidir.
 */
@Injectable()
export class SecurityMaintenanceService implements OnApplicationBootstrap, OnApplicationShutdown {
  private auditTimer?: NodeJS.Timeout;
  private retentionTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly auditVerification: AuditVerificationService,
    private readonly retention: RetentionService,
    private readonly config: AppConfigService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.env.AUDIT_VERIFICATION_ENABLED) {
      this.scheduleAudit();
    }
    if (this.config.env.RETENTION_ENABLED) {
      this.scheduleRetention();
    }
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.auditTimer !== undefined) {
      clearTimeout(this.auditTimer);
    }
    if (this.retentionTimer !== undefined) {
      clearTimeout(this.retentionTimer);
    }
  }

  private scheduleAudit(): void {
    if (this.stopped) {
      return;
    }
    this.auditTimer = setTimeout(() => {
      void this.guard('audit-verification', async () => {
        const result = await this.auditVerification.verifyOnce();
        if (result.status === 'BROKEN') {
          // Kopukluk istisna değil bulgudur: log'a `error` seviyesinde yazılır ve
          // alarm kuralı (Faz 13) bu kayda bağlanır.
          this.logger.error(
            { brokenAtId: result.brokenAtId },
            'Audit zinciri doğrulaması kopukluk buldu',
          );
        }
      }).finally(() => this.scheduleAudit());
    }, this.config.env.AUDIT_VERIFICATION_INTERVAL_MS);
    this.auditTimer.unref();
  }

  private scheduleRetention(): void {
    if (this.stopped) {
      return;
    }
    this.retentionTimer = setTimeout(() => {
      void this.guard('retention', () => this.retention.sweep()).finally(() =>
        this.scheduleRetention(),
      );
    }, this.config.env.RETENTION_INTERVAL_MS);
    this.retentionTimer.unref();
  }

  /** Bir adımın hatası zamanlayıcıyı durdurmamalı: iş bir sonraki turda yeniden denenir. */
  private async guard(step: string, work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.logger.error({ err: error, step }, 'Güvenlik bakım adımı başarısız');
    }
  }
}
