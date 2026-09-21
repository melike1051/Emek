import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { ROOT_LOGGER } from '../common/logging/logging.tokens';

/**
 * Safety gözlemlenebilirliği — yapılandırılmış, log tabanlı metrikler.
 *
 * Projede henüz bir metrik altyapısı yok (Faz 13/14). Bu sınıf her ölçümü **sabit
 * adlı** bir log satırı olarak yazar; Cloud Logging log-based metric'leri bu adlara
 * bağlanır. Adlar kapalı kümedir: serbest metin bir metrik adı panoda kaybolur.
 *
 * Kural: bu satırlar **koordinat, adres, kullanıcı kimliği taşımaz**. Korelasyon
 * için oturum kimliği (rastgele UUID, kişisel veri değil) ve istek kimliği
 * (request-context üzerinden logger'a zaten eklenir) yeterlidir. Log redaksiyonu
 * (`redact.ts`) koordinat anahtarlarını ayrıca maskeler.
 */
export const SAFETY_METRICS = [
  'safety.telemetry.batch',
  'safety.telemetry.rejected',
  'safety.geofence.transition',
  'safety.evaluation.completed',
  'safety.evaluation.discarded',
  'safety.anomaly.unavailable',
  'safety.route.unavailable',
  'safety.risk.changed',
  'safety.panic.raised',
  'safety.panic.notification_failed',
  'safety.session.transition',
  'safety.retention.purged',
  'safety.monitor.failed',
] as const;
export type SafetyMetric = (typeof SAFETY_METRICS)[number];

type MetricFields = Record<string, string | number | boolean | null>;

@Injectable()
export class SafetyMetrics {
  constructor(@Inject(ROOT_LOGGER) private readonly logger: Logger) {}

  record(metric: SafetyMetric, fields: MetricFields = {}): void {
    this.logger.info({ metric, ...fields }, metric);
  }

  /** Bağımlılık hatası: uyarı seviyesinde, aynı sabit adla. */
  failure(metric: SafetyMetric, fields: MetricFields = {}): void {
    this.logger.warn({ metric, ...fields }, metric);
  }
}
