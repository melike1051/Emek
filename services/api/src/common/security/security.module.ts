import { Module } from '@nestjs/common';
import { AUDIT_ARCHIVE } from '../audit/audit-archive.port';
import { AuditVerificationService } from '../audit/audit-verification.service';
import { MemoryAuditArchive } from '../audit/memory-audit-archive';
import { RetentionService } from '../retention/retention.service';
import { SecurityMaintenanceService } from './security-maintenance.service';

/**
 * Faz 12 güvenlik bakım modülü: audit zinciri doğrulaması + retention.
 *
 * Arşiv olarak yalnızca bellek uygulaması bağlıdır. Gerçek GCS arşivi ve onun
 * bucket retention policy'si **Faz 13**'e aittir (Terraform ile sağlanır, R-82);
 * production config'i dışa aktarımı bellek arşiviyle birlikte reddeder, yani
 * burada "üretimde çalışıyor" iddiası yoktur.
 */
@Module({
  providers: [
    { provide: AUDIT_ARCHIVE, useClass: MemoryAuditArchive },
    AuditVerificationService,
    RetentionService,
    SecurityMaintenanceService,
  ],
  exports: [AuditVerificationService, RetentionService, AUDIT_ARCHIVE],
})
export class SecurityModule {}
