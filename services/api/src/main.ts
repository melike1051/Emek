import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { AppConfigService } from './common/config/app-config.service';
import { EnvValidationError, validateEnv } from './common/config/env.schema';

async function bootstrap(): Promise<void> {
  // Config, Nest başlamadan doğrulanır: geçersiz ortamda hiç ayağa kalkmayız.
  validateEnv(process.env);

  // bufferLogs: framework logları, logger DI'dan gelene kadar tutulur.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = configureApp(app);
  const config = app.get(AppConfigService);

  try {
    await app.listen(config.env.PORT);
  } catch (error) {
    // Bu noktada DB pool ve Redis istemcisi açık: kapatmadan çıkmak, HTTP sunucusu
    // olmayan ama ayakta duran bir container bırakır.
    await app.close();
    throw error;
  }

  logger.info(
    {
      port: config.env.PORT,
      nodeEnv: config.env.NODE_ENV,
      identityProvider: config.env.IDENTITY_PROVIDER,
      paymentProvider: config.env.PAYMENT_PROVIDER,
    },
    'Emek core API started',
  );
}

bootstrap().catch((error: unknown) => {
  // Boot hatası structured logger kurulmadan da görünür olmalı.
  if (error instanceof EnvValidationError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`Core API başlatılamadı: ${String(error)}\n`);
  }
  // Açık handle'lar (pool, redis) süreci canlı tutabilir: başarısız boot'ta kesin çıkış.
  process.exit(1);
});
