import { RequestMethod, type INestApplication } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { IS_PUBLIC_KEY } from '../src/auth/auth.decorators';
import { API_PREFIX } from '../src/common/api.constants';
import { configureApp } from '../src/bootstrap';

interface DiscoveredRoute {
  key: string;
  isPublic: boolean;
}

/**
 * T-37 — **deny by default** denetimi.
 *
 * Kayıtlı her rota ya kimlik doğrulaması gerektirir ya da bilinçli olarak `@Public()`
 * ile işaretlenmiştir. Guard'ı takmayı unutmak mümkün olmamalı: yeni bir endpoint
 * eklenip yanlışlıkla açık bırakıldığında bu test kırılır.
 *
 * Kontrol, guard'ın kendi mantığıyla **aynı** yolu kullanır: metadata hem metot hem
 * sınıf seviyesinde aranır (`getAllAndOverride`). Express router tablosunu okumak
 * yeterli değildi — sınıf seviyesindeki `@Public` orada görünmüyor ve kontrol
 * sessizce boş geçiyordu.
 *
 * Sınır: bu test **metadata** denetler, istek göndermez. Guard'ın çalışma zamanındaki
 * davranışı (401/403 üretmesi) `auth-rbac.integration.spec.ts` tarafından doğrulanır;
 * ikisi birlikte "kayıtlı rota + gerçek davranış" kapsamını verir.
 */
const INTENTIONALLY_PUBLIC = new Set([
  'GET /api/v1/health',
  'GET /api/v1/health/live',
  'POST /api/v1/auth/session',
  'GET /api/v1/service-categories',
  'GET /api/v1/services',
  'GET /api/v1/services/:id',
  'GET /api/v1/skills',
]);

const METHOD_NAMES: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.ALL]: 'ALL',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
};

function joinPath(...segments: string[]): string {
  const path = segments
    .flatMap((segment) => segment.split('/'))
    .filter((segment) => segment.length > 0)
    .join('/');
  return `/${path}`;
}

function discoverRoutes(app: INestApplication): DiscoveredRoute[] {
  const discovery = app.get(DiscoveryService);
  const scanner = new MetadataScanner();
  const reflector = app.get(Reflector);

  const routes: DiscoveredRoute[] = [];

  for (const wrapper of discovery.getControllers()) {
    const instance = wrapper.instance as Record<string, unknown> | undefined;
    const controllerClass = wrapper.metatype;
    if (instance === undefined || typeof controllerClass !== 'function') {
      continue;
    }

    const controllerPath = (Reflect.getMetadata(PATH_METADATA, controllerClass) as string) ?? '';

    for (const methodName of scanner.getAllMethodNames(Object.getPrototypeOf(instance))) {
      const handler = instance[methodName];
      if (typeof handler !== 'function') {
        continue;
      }

      const httpMethod = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      if (httpMethod === undefined) {
        continue;
      }

      const methodPath = (Reflect.getMetadata(PATH_METADATA, handler) as string) ?? '';
      const fullPath = joinPath(API_PREFIX, controllerPath, methodPath);

      // Guard ile aynı çözümleme: metot metadata'sı sınıfı ezer.
      const isPublic =
        reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
          handler as (...args: unknown[]) => unknown,
          controllerClass,
        ]) === true;

      routes.push({ key: `${METHOD_NAMES[httpMethod] ?? 'UNKNOWN'} ${fullPath}`, isPublic });
    }
  }

  return routes;
}

describe('route coverage (integration)', () => {
  let app: INestApplication;
  let routes: DiscoveredRoute[];

  beforeAll(async () => {
    // DiscoveryModule yalnızca bu test için eklenir: üretim uygulamasına rota
    // denetimi uğruna bir modül eklemek gereksiz olurdu.
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, DiscoveryModule],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
    routes = discoverRoutes(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('rota keşfi çalışıyor (test kendini doğrular)', () => {
    // Keşif bozulursa aşağıdaki kontroller boş geçerdi.
    expect(routes.length).toBeGreaterThanOrEqual(15);
  });

  it('beyaz listede olmayan hiçbir rota kimlik doğrulamasız değildir', () => {
    const unexpectedPublic = routes
      .filter((route) => route.isPublic)
      .map((route) => route.key)
      .filter((key) => !INTENTIONALLY_PUBLIC.has(key))
      .sort();

    expect(unexpectedPublic).toEqual([]);
  });

  it('beyaz listedeki her rota gerçekten public olarak tespit edilir', () => {
    const detected = new Set(routes.filter((route) => route.isPublic).map((route) => route.key));
    const undetected = [...INTENTIONALLY_PUBLIC].filter((key) => !detected.has(key)).sort();

    expect(undetected).toEqual([]);
  });
});
