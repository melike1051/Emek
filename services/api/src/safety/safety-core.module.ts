import { Module } from '@nestjs/common';
import { SafetyLifecycleService } from './safety-lifecycle.service';
import { SafetyMetrics } from './safety-metrics';
import { SafetyRepository } from './safety.repository';

/**
 * Safety çekirdeği: kalıcılık, yaşam döngüsü ve gözlemlenebilirlik.
 *
 * Ayrı bir modüldür çünkü `BookingStateModule` onu import eder (oturum booking
 * geçişiyle aynı transaction'da ilerler) ve `SafetyModule` de booking modüllerini
 * import eder (panik rezervasyonu askıya alır). Çekirdek hiçbir booking modülünü
 * import etmediği için döngü oluşmaz.
 */
@Module({
  providers: [SafetyRepository, SafetyLifecycleService, SafetyMetrics],
  exports: [SafetyRepository, SafetyLifecycleService, SafetyMetrics],
})
export class SafetyCoreModule {}
