import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthService, type HealthReport } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Liveness: süreç ayakta mı? Bağımlılık kontrolü yapmaz.
   * Cloud Run/orchestrator bu endpoint'e göre container'ı yeniden başlatır —
   * geçici bir DB arızasında süreci öldürmek durumu kötüleştirir.
   */
  @Get('live')
  @HttpCode(HttpStatus.OK)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Readiness: bağımlılıklarla birlikte trafik alabilir durumda mı?
   * Bağımlılık düştüğünde 503 döner ve gövdede hangi kontrolün başarısız olduğunu bildirir.
   */
  @Get()
  async check(@Res({ passthrough: true }) res: Response): Promise<HealthReport> {
    const report = await this.health.check();
    res.status(report.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
