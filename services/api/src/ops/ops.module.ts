import { Module } from '@nestjs/common';
import { SecurityModule } from '../common/security/security.module';
import { NotificationJobsRepository } from './notification-jobs.repository';
import { OpsController } from './ops.controller';
import { OpsService } from './ops.service';

/**
 * Sistem sağlığı ve asenkron kuyruk operasyonları (Faz 10).
 *
 * `DeadLetterService` `EventsModule`'den (Global) gelir — burada ayrıca import
 * edilmez. `AuditModule`/`DatabaseModule` de Global'dır.
 */
@Module({
  imports: [SecurityModule],
  controllers: [OpsController],
  providers: [OpsService, NotificationJobsRepository],
})
export class OpsModule {}
