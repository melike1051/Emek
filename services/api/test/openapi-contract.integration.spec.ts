import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OpenAPIObject } from '@nestjs/swagger';
import { buildOpenApiDocument } from '../src/openapi';

const CONTRACT_PATH = resolve(__dirname, '../../../packages/api-contracts/openapi.json');

/**
 * Contract testi (ADR-0011).
 *
 * `packages/api-contracts/openapi.json` istemcilerin yazıldığı tek doğruluk kaynağıdır.
 * Kod ile dosya ayrışırsa istemciler sessizce yanlış sözleşmeye göre geliştirilir —
 * bu test, `npm run contracts:generate` çalıştırmayı unutan bir değişikliği yakalar.
 */
describe('OpenAPI contract (integration)', () => {
  let generated: OpenAPIObject;
  let committed: OpenAPIObject;

  beforeAll(async () => {
    generated = await buildOpenApiDocument();
    committed = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as OpenAPIObject;
  });

  it('commit edilmiş sözleşme koddan üretilenle aynıdır', () => {
    // Fark varsa: npm run contracts:generate --workspace=@emek/api
    expect(generated).toEqual(committed);
  });

  it('tüm yollar /api/v1 önekiyle sürümlenmiştir', () => {
    const unversioned = Object.keys(generated.paths ?? {}).filter(
      (path) => !path.startsWith('/api/v1/'),
    );

    expect(unversioned).toEqual([]);
  });

  it('bearer güvenlik şeması tanımlıdır', () => {
    expect(generated.components?.securitySchemes?.bearer).toEqual(
      expect.objectContaining({ type: 'http', scheme: 'bearer' }),
    );
  });

  it('Faz 2 endpoint.leri sözleşmede yer alır', () => {
    const paths = Object.keys(generated.paths ?? {});

    expect(paths).toEqual(
      expect.arrayContaining([
        '/api/v1/auth/session',
        '/api/v1/users/me',
        '/api/v1/users/me/roles',
        '/api/v1/customers/profile',
        '/api/v1/providers/profile',
        '/api/v1/providers/me/skills',
        '/api/v1/service-categories',
        '/api/v1/services',
        '/api/v1/skills',
        '/api/v1/verification/session',
        '/api/v1/verification/status',
        '/api/v1/addresses',
        '/api/v1/bookings',
        '/api/v1/bookings/{id}',
        '/api/v1/bookings/{id}/history',
        '/api/v1/providers/me/availability',
      ]),
    );
  });

  it('sözleşme henüz uygulanmamış endpoint içermez', () => {
    const paths = Object.keys(generated.paths ?? {});

    // Safety Faz 8'e ait: sözleşmede erken görünmemeli (istemciler var olmayan
    // endpoint'e göre geliştirilmesin). Ödeme Faz 5'te uygulandı ve artık listededir.
    expect(paths.filter((path) => /safety|telemetry/.test(path))).toEqual([]);
  });

  it('ödeme endpoint.leri sözleşmede yer alır', () => {
    const paths = Object.keys(generated.paths ?? {});

    expect(paths).toEqual(
      expect.arrayContaining([
        '/api/v1/bookings/{id}/payment',
        '/api/v1/payments/{id}/release',
        '/api/v1/payments/webhook',
        '/api/v1/bookings/{id}/disputes',
        '/api/v1/documents',
      ]),
    );
  });
});
