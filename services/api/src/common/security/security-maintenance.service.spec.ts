import type { Logger } from 'pino';
import { SecurityMaintenanceService } from './security-maintenance.service';
import type { AuditVerificationService } from '../audit/audit-verification.service';
import type { RetentionService } from '../retention/retention.service';
import { AppConfigService } from '../config/app-config.service';
import { validateEnv } from '../config/env.schema';
import { productionEnvFixture as productionEnv } from '../config/production-env.fixture';

const baseEnv = {
  DATABASE_URL: 'postgres://emek:secret@localhost:5432/emek',
  REDIS_URL: 'redis://localhost:6379',
};

function configWith(env: Record<string, string>): AppConfigService {
  return new AppConfigService(validateEnv({ ...baseEnv, ...env }));
}

function loggerStub(): Logger {
  return { info: jest.fn(), error: jest.fn(), warn: jest.fn() } as unknown as Logger;
}

/**
 * Bu servis üretimde retention'ın **tek** otomatik tetikleyicisidir:
 * `POST /ops/retention/sweep` yalnızca elle çalıştırma yoludur ve Terraform'da
 * hiçbir Cloud Scheduler işi yoktur. Döngü sessizce kopmuş olsa
 * `data-retention-inventory.md`'deki her "silen iş" satırı yalana dönüşürdü
 * (T-24, R-38) — bu yüzden zamanlamanın kendisi test edilir.
 */
describe('SecurityMaintenanceService', () => {
  let audit: { verifyOnce: jest.Mock };
  let retention: { sweep: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers();
    audit = { verifyOnce: jest.fn().mockResolvedValue({ status: 'OK' }) };
    retention = { sweep: jest.fn().mockResolvedValue({}) };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function build(config: AppConfigService): SecurityMaintenanceService {
    return new SecurityMaintenanceService(
      audit as unknown as AuditVerificationService,
      retention as unknown as RetentionService,
      config,
      loggerStub(),
    );
  }

  it('RETENTION_ENABLED ile sweep zamanlanır ve tur sonunda yeniden programlanır', async () => {
    const service = build(configWith({ RETENTION_ENABLED: 'true', RETENTION_INTERVAL_MS: '1000' }));
    service.onApplicationBootstrap();

    expect(retention.sweep).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1000);
    await jest.runAllTicks();
    expect(retention.sweep).toHaveBeenCalledTimes(1);

    // Yeniden programlama `.finally()` içinde olduğu için sweep promise'inin
    // çözülmesini beklemek gerekir; aksi halde ikinci tur hiç kurulmaz.
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(1000);
    await jest.runAllTicks();
    expect(retention.sweep).toHaveBeenCalledTimes(2);
  });

  it('sweep hatası döngüyü durdurmaz', async () => {
    retention.sweep.mockRejectedValueOnce(new Error('geçici hata'));
    const service = build(configWith({ RETENTION_ENABLED: 'true', RETENTION_INTERVAL_MS: '1000' }));
    service.onApplicationBootstrap();

    jest.advanceTimersByTime(1000);
    await jest.runAllTicks();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    jest.advanceTimersByTime(1000);
    await jest.runAllTicks();
    expect(retention.sweep).toHaveBeenCalledTimes(2);
  });

  it('RETENTION_ENABLED=false iken sweep hiç çalışmaz', () => {
    const service = build(configWith({ RETENTION_INTERVAL_MS: '1000' }));
    service.onApplicationBootstrap();

    jest.advanceTimersByTime(60_000);
    expect(retention.sweep).not.toHaveBeenCalled();
  });

  it('kapanış zamanlayıcıyı durdurur', async () => {
    const service = build(configWith({ RETENTION_ENABLED: 'true', RETENTION_INTERVAL_MS: '1000' }));
    service.onApplicationBootstrap();
    service.onApplicationShutdown();

    jest.advanceTimersByTime(10_000);
    await jest.runAllTicks();
    expect(retention.sweep).not.toHaveBeenCalled();
  });

  // Config katmanı dağıtılan ortamlarda retention'ı kapatılamaz yapar: bu
  // güvence gevşetilirse yukarıdaki döngü sessizce hiç kurulmaz.
  it('dağıtılan ortam yapılandırması retention kapalıyken reddedilir', () => {
    expect(() => validateEnv({ ...baseEnv, ...productionEnv, RETENTION_ENABLED: 'false' })).toThrow(
      /RETENTION_ENABLED/,
    );
  });
});
