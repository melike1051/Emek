import { z } from 'zod';

/**
 * Tek doğruluk kaynağı: uygulamanın ihtiyaç duyduğu tüm ortam değişkenleri.
 * Eksik veya geçersiz değerde servis başlamaz (fail fast) — yarım yapılandırılmış
 * bir servisin çalışmaya devam etmesi, hatayı ilk isteğe kadar saklar.
 */

const nodeEnvSchema = z.enum(['development', 'test', 'staging', 'production']);

const providerSchema = z.enum(['mock', 'sandbox', 'live']);

const portSchema = z.coerce.number().int().min(1).max(65535);

const postgresUrlSchema = z
  .string()
  .url()
  .refine((value) => value.startsWith('postgres://') || value.startsWith('postgresql://'), {
    message: 'DATABASE_URL postgres:// veya postgresql:// ile başlamalı',
  });

const redisUrlSchema = z
  .string()
  .url()
  .refine((value) => value.startsWith('redis://') || value.startsWith('rediss://'), {
    message: 'REDIS_URL redis:// veya rediss:// ile başlamalı',
  });

export const envSchema = z
  .object({
    NODE_ENV: nodeEnvSchema.default('development'),
    PORT: portSchema.default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    DATABASE_URL: postgresUrlSchema,
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),

    REDIS_URL: redisUrlSchema,

    IDENTITY_PROVIDER: providerSchema.default('mock'),
    PAYMENT_PROVIDER: providerSchema.default('mock'),

    // Kimlik doğrulama sağlayıcısı (ADR-0016). 'mock' yalnızca development/test içindir.
    AUTH_PROVIDER: z.enum(['firebase', 'mock']).default('mock'),
    FIREBASE_PROJECT_ID: z.string().min(1).default('emek-local'),

    // --- Identity (ADR-0004, ADR-0005) ---
    // Hash anahtarının kaynağı. Production'da yalnızca KMS kabul edilir; ortam
    // değişkenindeki bir anahtar, tekillik kontrolünü kâğıt üzerinde bırakırdı.
    IDENTITY_HASH_KEY_SOURCE: z.enum(['env', 'kms']).default('env'),
    IDENTITY_HASH_KEY: z.string().min(32).default('local-development-identity-hash-key-000'),
    IDENTITY_HASH_KEY_VERSION: z.string().min(1).default('v1'),
    IDENTITY_CALLBACK_SECRET: z.string().min(16).default('local-development-callback-secret'),
    VERIFICATION_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    VERIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
    VERIFICATION_ATTEMPT_WINDOW_SECONDS: z.coerce.number().int().min(60).default(3600),
    // Hesap kurtarma bir devralma yoludur: NFC tek başına yetmez (ADR-0005).
    RECOVERY_MIN_ASSURANCE: z.enum(['LOW', 'SUBSTANTIAL', 'HIGH']).default('HIGH'),

    AI_SERVICE_URL: z.string().url().default('http://localhost:8000'),
    AI_SERVICE_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(3000),

    GCP_PROJECT_ID: z.string().min(1).default('emek-local'),
    PUBSUB_EMULATOR_HOST: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    // ADR-0005 / ADR-0009: mock sağlayıcılar production'da seçilemez.
    // Bu kontrol config katmanındadır; runtime'da "acaba mock mu" diye sormak yerine
    // servis hiç başlamaz.
    if (env.NODE_ENV !== 'production') {
      return;
    }

    for (const key of ['IDENTITY_PROVIDER', 'PAYMENT_PROVIDER', 'AUTH_PROVIDER'] as const) {
      if (env[key] === 'mock') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key}=mock production ortamında kullanılamaz`,
        });
      }
    }

    // Firebase token doğrulaması audience/issuer olarak proje kimliğini kullanır;
    // yerel varsayılanla production'a çıkmak tüm token'ları geçersiz kılar (ADR-0016).
    if (env.AUTH_PROVIDER === 'firebase' && env.FIREBASE_PROJECT_ID === 'emek-local') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FIREBASE_PROJECT_ID'],
        message: 'FIREBASE_PROJECT_ID production ortamında gerçek proje kimliği olmalı',
      });
    }

    if (env.IDENTITY_HASH_KEY_SOURCE !== 'kms') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['IDENTITY_HASH_KEY_SOURCE'],
        message:
          'IDENTITY_HASH_KEY_SOURCE production ortamında kms olmalı (ADR-0004: anahtar KMS.te tutulur)',
      });
    }

    // Varsayılan yerel sırlarla production'a çıkmak, imza ve hash korumalarını etkisiz kılar.
    const localDefaults: [string, string][] = [
      ['IDENTITY_HASH_KEY', 'local-development-identity-hash-key-000'],
      ['IDENTITY_CALLBACK_SECRET', 'local-development-callback-secret'],
    ];
    for (const [key, localValue] of localDefaults) {
      if (env[key as 'IDENTITY_HASH_KEY' | 'IDENTITY_CALLBACK_SECRET'] === localValue) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} production ortamında yerel varsayılan değeri olamaz`,
        });
      }
    }

    if (env.PUBSUB_EMULATOR_HOST !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PUBSUB_EMULATOR_HOST'],
        message: 'PUBSUB_EMULATOR_HOST production ortamında tanımlı olamaz',
      });
    }
  });

export type AppEnv = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Ortam değişkeni doğrulaması başarısız:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

export function validateEnv(source: NodeJS.ProcessEnv): AppEnv {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    // Sadece alan adı ve sebep raporlanır; değerler loglanmaz (secret sızıntısı riski).
    const issues = result.error.issues.map((issue) => {
      const field = issue.path.join('.') || '(kök)';
      return `${field}: ${issue.message}`;
    });
    throw new EnvValidationError(issues);
  }

  return result.data;
}
