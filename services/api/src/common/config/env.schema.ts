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

    // --- Payment (ADR-0009) ---
    PAYMENT_WEBHOOK_SECRET: z.string().min(16).default('local-development-payment-secret'),
    // Yetkilendirmenin geçerlilik süresi. Gerçek sağlayıcılarda tipik olarak birkaç gün;
    // hizmet günü bundan sonraysa re-authorization zorunludur (ADR-0009 §4).
    PAYMENT_AUTHORIZATION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),
    // Yetkilendirmenin bitişine bu süreden az kaldıysa yenileme gerekir.
    PAYMENT_REAUTH_THRESHOLD_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    PAYMENT_MAX_REAUTHORIZATIONS: z.coerce.number().int().min(0).max(10).default(3),

    // --- Object storage (dijital ispat) ---
    // Nesneler private'tır; erişim yalnızca kısa ömürlü signed URL ile olur (T-12).
    STORAGE_PROVIDER: z.enum(['mock', 'gcs']).default('mock'),
    STORAGE_BUCKET: z.string().min(1).default('emek-local-documents'),
    STORAGE_SIGNING_SECRET: z.string().min(16).default('local-development-storage-secret'),
    // URL ömrü kısa tutulur: uzun ömürlü imzalı URL, pratikte public link demektir.
    STORAGE_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    STORAGE_MAX_UPLOAD_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(64 * 1024 * 1024)
      .default(10 * 1024 * 1024),

    AI_SERVICE_URL: z.string().url().default('http://localhost:8000'),
    /**
     * Hizmet saatlerinin yorumlandığı zaman dilimi ofseti.
     *
     * NLP çıktısındaki saatler **yerel saattir** (müşterinin "sabah" dediği saat);
     * mutlak ana çevrilirken bu ofset kullanılır. Türkiye 2016'dan beri yaz saati
     * uygulamıyor ve sabit UTC+03:00'tedir — bu yüzden sabit ofset yeterli.
     * TODO(legal): yaz saati uygulaması geri gelirse veya başka bir ülkeye açılırsa
     * IANA zaman dilimi (Europe/Istanbul) ile değiştirilmeli.
     */
    SERVICE_TIMEZONE_OFFSET: z
      .string()
      .regex(/^[+-][0-9]{2}:[0-9]{2}$/, 'SERVICE_TIMEZONE_OFFSET ±HH:MM biçiminde olmalı')
      .default('+03:00'),
    AI_SERVICE_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(3000),

    // --- Matching / Optimization (ADR-0007, Faz 7) ---
    /**
     * Karar motoru çağrısının zaman aşımı.
     *
     * NLP'den uzun tutulur: optimizasyon kombinatoryal bir problemi çözer ve
     * AI servisi kendi içinde ayrıca bir çözücü zaman limiti uygular. Süre
     * dolduğunda core kendi deterministik yedek sıralamasına düşer.
     */
    MATCHING_SERVICE_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(10000),
    /**
     * Mutlak mesafe üst sınırı (metre).
     *
     * Hizmet bölgesi poligonu "evet" dese bile aşılamaz: yanlış çizilmiş tek bir
     * poligon şehirler arası atama üretebilirdi. AI servisindeki
     * `AI_MATCHING_MAX_DISTANCE_METERS` ile aynı değeri taşımalıdır.
     */
    MATCHING_MAX_DISTANCE_METERS: z.coerce.number().int().min(1000).max(500000).default(50000),
    /**
     * Tek talep için değerlendirilecek en fazla aday.
     *
     * Sınırsız bir havuz hem sorguyu hem optimizasyonu aday sayısıyla birlikte
     * büyütür (R-16). Havuz mesafeye göre sıralandığı için sınır "en yakın N" demektir.
     */
    MATCHING_CANDIDATE_LIMIT: z.coerce.number().int().min(1).max(200).default(50),
    /** Tek toplu çalıştırmada birlikte çözülecek en fazla talep. */
    MATCHING_BATCH_LIMIT: z.coerce.number().int().min(1).max(100).default(25),

    // --- Safety (ADR-0008, ADR-0019, Faz 8) ---
    /**
     * Anomali modeli çağrısının zaman aşımı.
     *
     * Matching'den **kısadır** ve bu bilinçlidir: anomali skoru destekleyici bir
     * sinyaldir; güvenlik kararını geciktirmeye değmez. Süre dolduğunda
     * değerlendirme deterministik kurallarla tamamlanır. Panik bu çağrıyı hiç yapmaz.
     */
    SAFETY_ANOMALY_TIMEOUT_MS: z.coerce.number().int().min(100).max(10000).default(1500),
    /**
     * Geofence yarıçapı (metre) — oturum açılırken başlangıç değeri olarak kullanılır.
     *
     * Tek evrensel yarıçap yoktur; bu yalnızca başlangıç değeridir ve oturuma
     * kopyalanır ki karar yeniden üretilebilsin. Kırsal adres ile apartman dairesi
     * aynı toleransı taşımaz (R-56).
     */
    SAFETY_GEOFENCE_RADIUS_METERS: z.coerce.number().int().min(25).max(5000).default(150),
    /** Bu doğruluğun üstündeki örnekler geofence kararına girmez (`INSUFFICIENT_ACCURACY`). */
    SAFETY_GEOFENCE_ACCURACY_LIMIT_METERS: z.coerce.number().int().min(10).max(2000).default(100),
    /** Bir geofence durumunun kabul edilmesi için gereken ardışık kesin gözlem sayısı. */
    SAFETY_GEOFENCE_DEBOUNCE_SAMPLES: z.coerce.number().int().min(1).max(10).default(3),
    /** İstemcinin telemetri göndermesi beklenen aralık (saniye); oturuma kopyalanır. */
    SAFETY_TELEMETRY_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(600).default(30),
    /**
     * İstemci saatinin sunucu saatinden **ileride** olabileceği azami sapma (saniye).
     *
     * Sunucu zamanı yetkilidir (ADR-0008 §7); bu sınır geleceğe tarihli kayıt
     * yazmayı engeller.
     */
    SAFETY_TELEMETRY_MAX_SKEW_SECONDS: z.coerce.number().int().min(10).max(900).default(120),
    /**
     * Kabul edilen en eski örnek yaşı (saniye).
     *
     * Cihaz uykuya geçip tamponladığı örnekleri sonradan gönderebilir (gecikmeli
     * telemetri). Bu pencere içindeki örnekler kabul edilir; daha eskiler bayattır.
     */
    SAFETY_TELEMETRY_MAX_AGE_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    /**
     * Fiziksel olarak mümkün kabul edilen azami hız (m/sn).
     *
     * Varsayılan 60 m/sn ≈ 216 km/sa: şehir içi ulaşımın çok üstünde ama uçak
     * yolculuğunun altında. Doğruluk daireleri düşüldükten sonra bunu aşan sıçrama
     * sahte veya bozuk konumdur.
     */
    SAFETY_MAX_SPEED_MPS: z.coerce.number().int().min(10).max(400).default(60),
    /** Aynı oturum için iki risk değerlendirmesi arasındaki asgari süre (saniye). */
    SAFETY_EVALUATION_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3600).default(120),
    /**
     * Arka plan izleyicisi (değerlendirme + oturum süresi + retention) açık mı.
     *
     * Integration testlerinde kapatılır: zamanlayıcının test verisini kendi
     * başına değiştirmesi, testlerin ölçtüğü şeyi belirsizleştirirdi. Testler
     * aynı işleri servis üzerinden açıkça tetikler.
     */
    SAFETY_MONITOR_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    /** İzleyici turları arasındaki süre (saniye). */
    SAFETY_MONITOR_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(600).default(30),
    /**
     * Ham konum kaydının saklanma süresi (gün), planlanan bitişten itibaren.
     *
     * ADR-0008 §5'teki öneri 30 gün. TODO(legal): süre hukuk görüşüyle
     * doğrulanacak (A-04).
     */
    SAFETY_LOCATION_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    /**
     * Panik/acil durum oturumlarında ham konum kaydının kanıt olarak saklanma süresi (gün).
     *
     * TODO(legal): acil durum ve olası adli süreç için saklama süresi hukuk görüşüyle
     * belirlenecek (A-04, R-58). Varsayılan bir **öneridir**, hukuki gereklilik değil.
     */
    SAFETY_EVIDENCE_RETENTION_DAYS: z.coerce.number().int().min(30).max(3650).default(365),
    /**
     * AI servisine giden isteklerin taşıdığı paylaşılan sır.
     *
     * Ağ politikası tek savunma katmanı olmamalı (ADR-0013 "deny by default");
     * production'da zorunludur.
     */
    AI_SERVICE_API_KEY: z.string().min(16).optional(),

    GCP_PROJECT_ID: z.string().min(1).default('emek-local'),
    PUBSUB_EMULATOR_HOST: z.string().min(1).optional(),

    EVENT_TRANSPORT_TYPE: z.enum(['logging', 'pubsub']).default('logging'),
    PUBSUB_PROJECT_ID: z.string().optional(),
    SCHEDULED_RELEASE_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((val) => val === 'true'),
    SCHEDULED_RELEASE_INTERVAL_MS: z.coerce.number().int().min(1000).default(60000),
    SCHEDULED_RELEASE_DISPUTE_WINDOW_HOURS: z.coerce.number().int().min(1).default(48),
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
      ['PAYMENT_WEBHOOK_SECRET', 'local-development-payment-secret'],
      ['STORAGE_SIGNING_SECRET', 'local-development-storage-secret'],
    ];
    for (const [key, localValue] of localDefaults) {
      if (
        env[
          key as
            | 'IDENTITY_HASH_KEY'
            | 'IDENTITY_CALLBACK_SECRET'
            | 'PAYMENT_WEBHOOK_SECRET'
            | 'STORAGE_SIGNING_SECRET'
        ] === localValue
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} production ortamında yerel varsayılan değeri olamaz`,
        });
      }
    }

    // Mock storage bellekte tutar ve süreç yeniden başladığında kanıtları kaybeder;
    // "dijital ispat" iddiası bununla taşınamaz.
    if (env.STORAGE_PROVIDER !== 'gcs') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STORAGE_PROVIDER'],
        message: 'STORAGE_PROVIDER production ortamında gcs olmalı',
      });
    }

    // AI servisi yalnızca ağ yapılandırmasına güvenemez (Faz 6 review bulgusu L1).
    if (env.AI_SERVICE_API_KEY === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AI_SERVICE_API_KEY'],
        message: 'AI_SERVICE_API_KEY production ortamında tanımlı olmalı',
      });
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
