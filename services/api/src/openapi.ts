import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { API_PREFIX } from './common/api.constants';

/**
 * OpenAPI dokümanını koddan üretir.
 *
 * Sözleşme tek doğruluk kaynağıdır (`packages/api-contracts/openapi.json`) ve hem
 * üretim scripti hem contract testi bu fonksiyonu kullanır — ikisi ayrışamaz.
 *
 * Doküman üretmek için uygulama başlatılır ama HTTP dinlenmez; bağımlılıklar
 * (Postgres/Redis) yalnızca bağlantı havuzu olarak kurulur, sorgu yapılmaz.
 */
export async function buildOpenApiDocument(): Promise<OpenAPIObject> {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix(API_PREFIX);

  try {
    const config = new DocumentBuilder()
      .setTitle('Emek Core API')
      .setDescription(
        'İki taraflı dijital hizmet pazaryeri çekirdek API. Hata kodları: docs/api/error-codes.md',
      )
      .setVersion('v1')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Firebase ID token (ADR-0016)',
        },
        'bearer',
      )
      .build();

    return SwaggerModule.createDocument(app, config, { deepScanRoutes: true });
  } finally {
    await app.close();
  }
}
