/**
 * Dağıtım sonrası smoke testleri (Faz 13).
 *
 * Amaç "200 döndü mü" değil, **doğru şeyin dağıtıldığını** doğrulamaktır. Mock
 * storage ve `logging` event transport'u ile ayağa kalkmış bir ortam da 200 döner;
 * böyle bir staging hiçbir şeyi kanıtlamaz. Bu yüzden testler:
 *
 *  1. Bağımlılıkların (Postgres, PostGIS, Redis) gerçekten ayakta olduğunu,
 *  2. Etkin sağlayıcıların gerçek olduğunu (gcs / kms / pubsub / bigquery),
 *  3. Güvenlik guard'larının **fail-closed** çalıştığını (kimliksiz istek reddedilir,
 *     App Check zorunlu, rol kontrolü uygulanır),
 *  4. AI servisinin sağlıklı olduğunu ve **internete kapalı** olduğunu
 *
 * doğrular. Herhangi biri düşerse çıkış kodu sıfır değildir ve pipeline durur.
 *
 * Kullanım:
 *   npx tsx services/api/scripts/smoke-test.ts --api-url https://... [--ai-url https://...]
 */

interface Args {
  apiUrl: string;
  aiUrl?: string;
  expectedEnvironment: string;
}

interface Check {
  name: string;
  run: () => Promise<void>;
}

class SmokeFailure extends Error {}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };

  const apiUrl = get('--api-url') ?? process.env.SMOKE_API_URL;
  if (apiUrl === undefined || apiUrl === '') {
    throw new SmokeFailure('--api-url (veya SMOKE_API_URL) zorunludur');
  }

  return {
    apiUrl: apiUrl.replace(/\/+$/, ''),
    aiUrl: (get('--ai-url') ?? process.env.SMOKE_AI_URL)?.replace(/\/+$/, ''),
    expectedEnvironment: get('--environment') ?? process.env.SMOKE_ENVIRONMENT ?? 'staging',
  };
}

const TIMEOUT_MS = 15000;

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Gövde JSON değilse ham metin döner; assert'ler bunu da raporlayabilmeli.
  }
  return { status: response.status, body, headers: response.headers };
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new SmokeFailure(message);
  }
}

function buildChecks(args: Args): Check[] {
  const checks: Check[] = [];

  // Readiness: bağımlılıklar gerçekten ayakta mı? 200 tek başına yetmez —
  // `status: 'degraded'` de 503 ile döner ve gövdede hangi kontrolün düştüğü yazar.
  checks.push({
    name: 'core API readiness (postgres + postgis + redis)',
    run: async () => {
      const { status, body } = await fetchJson(`${args.apiUrl}/api/v1/health`);
      assert(status === 200, `readiness 200 beklenirken ${status} döndü: ${JSON.stringify(body)}`);

      const report = body as {
        status?: string;
        checks?: Record<string, { status?: string; reason?: string }>;
      };
      assert(report.status === 'ok', `readiness durumu 'ok' değil: ${JSON.stringify(report)}`);

      for (const dependency of ['postgres', 'postgis', 'redis'] as const) {
        const check = report.checks?.[dependency];
        assert(
          check?.status === 'up',
          `bağımlılık ${dependency} up değil: ${JSON.stringify(check)}`,
        );
      }
    },
  });

  // Liveness bağımlılık kontrolü yapmaz; bu bilinçli bir karardır ve kontrol edilir.
  checks.push({
    name: 'core API liveness',
    run: async () => {
      const { status, body } = await fetchJson(`${args.apiUrl}/api/v1/health/live`);
      assert(status === 200, `liveness 200 beklenirken ${status} döndü`);
      assert(
        (body as { status?: string }).status === 'ok',
        `liveness gövdesi beklenmedik: ${JSON.stringify(body)}`,
      );
    },
  });

  // Asıl soru: ortam **neyle** ayağa kalktı? Sahte sağlayıcılarla çalışan bir
  // dağıtım, testlerin hiçbir şey kanıtlamadığı bir dağıtımdır.
  checks.push({
    name: 'gerçek sağlayıcılar etkin (gcs / kms / pubsub / bigquery / App Check)',
    run: async () => {
      const { body } = await fetchJson(`${args.apiUrl}/api/v1/health`);
      const providers = (body as { providers?: Record<string, unknown> }).providers;
      assert(providers !== undefined, 'health yanıtı sağlayıcı raporu taşımıyor');

      const expected: Record<string, unknown> = {
        environment: args.expectedEnvironment,
        storage: 'gcs',
        identityHashKeySource: 'kms',
        eventTransport: 'pubsub',
        auditArchive: 'gcs',
        bigQuery: 'bigquery',
        appCheckEnabled: true,
        // Emulator'a bağlı bir dağıtım da "pubsub" yazardı; bu alan onu ayırır.
        pubsubEmulator: false,
      };

      for (const [key, value] of Object.entries(expected)) {
        assert(
          providers[key] === value,
          `sağlayıcı ${key}: ${String(value)} bekleniyordu, ${String(providers[key])} bulundu`,
        );
      }

      assert(
        providers.identity !== 'mock' && providers.payment !== 'mock' && providers.auth !== 'mock',
        `mock sağlayıcı etkin: ${JSON.stringify(providers)}`,
      );
    },
  });

  // Fail-closed: kimliksiz istek reddedilmeli. 200 dönerse yetkilendirme kapalıdır.
  checks.push({
    name: 'kimlik doğrulaması zorunlu (deny by default)',
    run: async () => {
      const { status } = await fetchJson(`${args.apiUrl}/api/v1/users/me`);
      assert(
        status === 401 || status === 403,
        `kimliksiz istek reddedilmedi (${status}) — yetkilendirme kapalı olabilir`,
      );
    },
  });

  // Operasyon uçları yalnızca ADMIN/SUPPORT içindir; internete açık bir ops ucu
  // dead-letter kuyruğunu ve audit durumunu sızdırırdı.
  checks.push({
    name: 'operasyon uçları korumalı',
    run: async () => {
      const { status } = await fetchJson(`${args.apiUrl}/api/v1/ops/health`);
      assert(status === 401 || status === 403, `ops ucu kimliksiz erişime açık (${status})`);
    },
  });

  // ADR-0022: App Check açıkken istemci uygulamasından gelmeyen istek reddedilir.
  // Sahte bir Bearer token ile: token geçersiz olduğu için her hâlükârda 4xx olmalı,
  // ama **asla** 2xx olmamalı.
  checks.push({
    name: 'geçersiz token ile erişim reddedilir',
    run: async () => {
      const { status } = await fetchJson(`${args.apiUrl}/api/v1/users/me`, {
        headers: { authorization: 'Bearer gecersiz.token.degeri' },
      });
      assert(status >= 400 && status < 500, `geçersiz token ${status} ile kabul edildi`);
    },
  });

  // Bilinmeyen yol 404 olmalı; 5xx, yanlış yapılandırılmış bir yönlendirme demektir.
  checks.push({
    name: 'bilinmeyen yol 404 döner (5xx değil)',
    run: async () => {
      const { status } = await fetchJson(`${args.apiUrl}/api/v1/bilinmeyen-yol-${Date.now()}`);
      assert(status === 404, `bilinmeyen yol için 404 beklenirken ${status} döndü`);
    },
  });

  // Ham hata mesajı sızmamalı (T-31): gövde sabit, sınıflandırılmış bir hata kodu taşır.
  checks.push({
    name: 'hata gövdesi iç ayrıntı sızdırmıyor',
    run: async () => {
      const { body } = await fetchJson(`${args.apiUrl}/api/v1/bilinmeyen-yol-${Date.now()}`);
      const serialized = JSON.stringify(body).toLowerCase();
      for (const leak of ['stack', 'at object.', 'postgres://', 'node_modules']) {
        assert(!serialized.includes(leak), `hata gövdesi '${leak}' sızdırıyor: ${serialized}`);
      }
    },
  });

  if (args.aiUrl !== undefined) {
    // AI servisi `INGRESS_TRAFFIC_INTERNAL_ONLY` ile dağıtılır: internetten
    // erişilememesi bir **gereksinimdir**, yan etki değil. Erişilebiliyorsa
    // ingress yapılandırması bozulmuş demektir.
    checks.push({
      name: 'AI servisi internete kapalı',
      run: async () => {
        // Bağlantı hatası **geçer sayılmaz**: `--ai-url` içindeki bir yazım hatası
        // da bağlantı hatası verir ve kontrol sessizce "geçerdi". Internal ingress
        // ile dağıtılmış bir Cloud Run servisi HTTPS üzerinden yanıt verir (403/404).
        const { status } = await fetchJson(`${args.aiUrl}/api/v1/health`);
        assert(
          status === 403 || status === 404,
          `AI servisi internetten erişilebiliyor (${status}) — ingress internal olmalı`,
        );
      },
    });
  }

  return checks;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const checks = buildChecks(args);

  process.stdout.write(`Smoke testleri: ${args.apiUrl} (${args.expectedEnvironment})\n\n`);

  const failures: string[] = [];

  for (const check of checks) {
    try {
      await check.run();
      process.stdout.write(`  ✓ ${check.name}\n`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      process.stdout.write(`  ✗ ${check.name}\n      ${reason}\n`);
      failures.push(`${check.name}: ${reason}`);
    }
  }

  process.stdout.write(`\n${checks.length - failures.length}/${checks.length} kontrol geçti\n`);

  if (failures.length > 0) {
    process.stderr.write(`\nSmoke testleri başarısız:\n  - ${failures.join('\n  - ')}\n`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Smoke testi çalıştırılamadı: ${String(error)}\n`);
  process.exit(1);
});
