import { Module } from '@nestjs/common';
import { AUDIT_ARCHIVE, type AuditArchive } from '../audit/audit-archive.port';
import { AuditVerificationService } from '../audit/audit-verification.service';
import { GcsAuditArchive } from '../audit/gcs-audit-archive';
import { MemoryAuditArchive } from '../audit/memory-audit-archive';
import { AppConfigService } from '../config/app-config.service';
import { RetentionService } from '../retention/retention.service';
import { SecurityMaintenanceService } from './security-maintenance.service';

/**
 * Güvenlik bakım modülü: audit zinciri doğrulaması + retention + arşiv.
 *
 * Arşiv sağlayıcısı yapılandırmadan seçilir (Faz 13, R-82): geliştirmede bellek,
 * production'da GCS. Production config'i `memory`yi reddeder — bellekteki bir arşiv
 * "veritabanından bağımsız kopya" iddiasını taşıyamaz.
 */
@Module({
  providers: [
    MemoryAuditArchive,
    {
      provide: AUDIT_ARCHIVE,
      inject: [AppConfigService, MemoryAuditArchive],
      useFactory: (config: AppConfigService, memory: MemoryAuditArchive): AuditArchive =>
        config.env.AUDIT_ARCHIVE_PROVIDER === 'gcs' ? GcsAuditArchive.create(config) : memory,
    },
    AuditVerificationService,
    RetentionService,
    SecurityMaintenanceService,
  ],
  exports: [AuditVerificationService, RetentionService, AUDIT_ARCHIVE],
})
export class SecurityModule {}
