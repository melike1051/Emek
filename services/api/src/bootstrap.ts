import { ValidationPipe, type INestApplication } from '@nestjs/common';
import type { Logger } from 'pino';
import { API_PREFIX } from './common/api.constants';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { ROOT_LOGGER } from './common/logging/logging.module';
import { PinoLoggerService } from './common/logging/pino-logger.service';

/**
 * Uygulamanın HTTP davranışını yapılandırır.
 *
 * Bu fonksiyon hem `main.ts` hem de integration testleri tarafından kullanılır:
 * prefix, validation ve hata yönetimi tek yerde tanımlıdır, böylece testler
 * üretimde çalışan yapılandırmayı doğrular (kopyalanmış ikinci bir kurulum değil).
 */
export function configureApp(app: INestApplication): Logger {
  const logger = app.get<Logger>(ROOT_LOGGER);
  app.useLogger(new PinoLoggerService(logger));

  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      validateCustomDecorators: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter(logger));
  app.enableShutdownHooks();

  return logger;
}
