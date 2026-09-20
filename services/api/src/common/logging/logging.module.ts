import { Global, Module } from '@nestjs/common';
import type { Logger } from 'pino';
import { AppConfigService } from '../config/app-config.service';
import { createRootLogger } from './logger';
import { ROOT_LOGGER } from './logging.tokens';

export { ROOT_LOGGER } from './logging.tokens';

/**
 * Uygulamada tek bir pino örneği olur: Nest framework logları, exception filter ve
 * altyapı modülleri aynı logger'ı paylaşır (çift transport ve ayrışan yapılandırma olmaz).
 */
@Global()
@Module({
  providers: [
    {
      provide: ROOT_LOGGER,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): Logger =>
        createRootLogger({
          level: config.env.LOG_LEVEL,
          pretty: config.isDevelopment,
        }),
    },
  ],
  exports: [ROOT_LOGGER],
})
export class LoggingModule {}
