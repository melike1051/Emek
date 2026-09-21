import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { ANOMALY_CLIENT } from './anomaly.port';
import { EMERGENCY_NOTIFIER, LoggingEmergencyNotifier } from './emergency-notifier.port';
import { HttpAnomalyClient } from './http-anomaly.client';
import { PanicService } from './panic.service';
import { SafetyCoreModule } from './safety-core.module';
import { SafetyEvaluationService } from './safety-evaluation.service';
import { SafetyMaintenanceService } from './safety-maintenance.service';
import { SafetyOperatorService } from './safety-operator.service';
import { SafetyController } from './safety.controller';
import { TelemetryService } from './telemetry.service';

/**
 * Safety modülü (ADR-0008, ADR-0019).
 *
 * NLP ve matching modülleriyle aynı ilke: **mock istemci yoktur**. "Anomali servisi
 * down" senaryosu testlerde gerçek istemcinin erişilemeyen bir adrese bağlanmasıyla
 * kurulur; ölçülmek istenen tam olarak o yoldur. Değiştirilebilir sınırlar yalnızca
 * dış bağımlılıklardır (anomali istemcisi, acil durum bildirimi).
 */
@Module({
  imports: [SafetyCoreModule, BookingsModule],
  controllers: [SafetyController],
  providers: [
    TelemetryService,
    PanicService,
    SafetyEvaluationService,
    SafetyOperatorService,
    SafetyMaintenanceService,
    HttpAnomalyClient,
    { provide: ANOMALY_CLIENT, useExisting: HttpAnomalyClient },
    LoggingEmergencyNotifier,
    { provide: EMERGENCY_NOTIFIER, useExisting: LoggingEmergencyNotifier },
  ],
  exports: [SafetyEvaluationService, SafetyMaintenanceService, PanicService, TelemetryService],
})
export class SafetyModule {}
