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
    /**
     * Memorystore'un sunduğu CA sertifikası (PEM).
     *
     * `SERVER_AUTHENTICATION` modunda Memorystore kendi CA'sıyla imzalanmış bir
     * sertifika sunar; bu CA public güven deposunda **yoktur**. `rediss://` ile
     * bağlanırken verilmezse el sıkışma doğrulamada düşer. Yerelde TLS yoktur,
     * bu yüzden opsiyoneldir — ama `rediss://` ile birlikte zorunludur (aşağıda).
     */
    REDIS_CA_CERT: z.string().min(1).optional(),

    /**
     * Önümüzde duran **güvenilen** ters proxy sayısı (R-53, ADR-0022).
     *
     * `X-Forwarded-For` istemci tarafından yazılabilir; bu sayı, zincirin sağından
     * kaç hop'un bizim altyapımıza ait olduğunu söyler. Semantiği Express'in
     * `trust proxy: <n>` ayarıyla aynıdır ama karar `resolveClientIp`'tedir:
     * Express'in `trust proxy` ayarı **açılmaz**, çünkü naif kullanımı en soldaki
     * (saldırgan kontrolündeki) girdiyi seçer.
     *
     * 0 = hiçbir başlığa güvenilmez, yalnızca soket adresi. Cloud Run arkasında
     * doğru değer 2'dir ("istemci, google-lb" + soket); Faz 13'te gerçek topoloji
     * üzerinde doğrulanacak (TODO: R-53 kapanışı dağıtımla birlikte).
     */
    TRUSTED_PROXY_HOP_COUNT: z.coerce.number().int().min(0).max(10).default(0),

    /**
     * Firebase App Check zorunluluğu (ADR-0022).
     *
     * Açıkken `@SkipAppCheck()` ile işaretlenmemiş her HTTP rotası geçerli bir
     * App Check token'ı ister. Geliştirme ve Faz 16 öncesi testler için kapalıdır;
     * production'da zorunlu açıktır.
     */
    APP_CHECK_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    APP_CHECK_PROVIDER: z.enum(['firebase', 'mock']).default('mock'),
    /** App Check token'ının issuer/audience iddiası proje **numarasını** taşır. */
    FIREBASE_PROJECT_NUMBER: z.string().min(1).default('000000000000'),

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
    /**
     * Cloud KMS MAC anahtarının **sürüm** kaynak adı (Faz 13, R-39).
     *
     * Biçim: `projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>/cryptoKeyVersions/<n>`.
     * Sürüm açıkça yazılır: KMS "primary" sürümü sessizce değişirse aynı kişi farklı
     * hash üretir ve tekillik bozulurdu (ADR-0004 §5 — rotasyon yoktur).
     * Anahtar materyali uygulamaya **hiç** taşınmaz; HMAC'i KMS hesaplar (`macSign`).
     */
    IDENTITY_KMS_KEY_NAME: z.string().min(1).optional(),
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

    /**
     * BigQuery export worker'ı (Faz 11, ADR-0021). Kapalıyken `analytics_events`
     * yalnızca PostgreSQL'de birikir — hiçbir transactional akış buna bağlı değildir.
     */
    ANALYTICS_EXPORT_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((val) => val === 'true'),
    ANALYTICS_EXPORT_INTERVAL_MS: z.coerce.number().int().min(1000).default(30000),
    ANALYTICS_EXPORT_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(500),
    BIGQUERY_PROVIDER: z.enum(['mock', 'bigquery']).default('mock'),
    BIGQUERY_DATASET: z.string().min(1).default('emek_analytics'),
    BIGQUERY_PROJECT_ID: z.string().optional(),
    BIGQUERY_RAW_TABLE: z.string().min(1).default('raw_events'),

    /** Ödeme mutabakat taraması (Faz 11, ADR-0021). Para hareketi tetiklemez. */
    RECONCILIATION_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((val) => val === 'true'),
    RECONCILIATION_INTERVAL_MS: z.coerce.number().int().min(1000).default(900000),
    RECONCILIATION_STUCK_COMMAND_MINUTES: z.coerce.number().int().min(1).default(15),
    RECONCILIATION_AUTH_EXPIRY_GRACE_MINUTES: z.coerce.number().int().min(1).default(60),
    RECONCILIATION_RELEASE_PENDING_GRACE_MINUTES: z.coerce.number().int().min(1).default(120),

    // --- Security hardening (Faz 12, ADR-0022) ---
    /**
     * Periyodik audit hash zinciri doğrulaması.
     *
     * Zincir tamper-**evident**'tır: kopukluk ancak birisi baktığında görünür.
     * Bu iş "birisi"dir. Kapalıyken zincir yazılmaya devam eder, yalnızca
     * otomatik kontrol yapılmaz.
     */
    AUDIT_VERIFICATION_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    AUDIT_VERIFICATION_INTERVAL_MS: z.coerce.number().int().min(1000).default(3600000),
    /** Tek turda doğrulanacak azami satır; tüm tabloyu her turda taramak ölçeklenmez. */
    AUDIT_VERIFICATION_BATCH_SIZE: z.coerce.number().int().min(1).max(100000).default(5000),
    /**
     * Retention-locked audit dışa aktarımı (ADR-0013 §8).
     *
     * Doğrulanmış zincir parçaları değiştirilemez depolamaya yazılır; veritabanı
     * ele geçirilse bile bağımsız bir kopya kalır. Kapalıyken yalnızca doğrulama
     * çalışır, dışa aktarım yapılmaz.
     */
    AUDIT_EXPORT_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    /**
     * Arşiv sağlayıcısı. `memory` bellekte tutar ve süreç yeniden başladığında
     * kaybolur — "bağımsız kopya" iddiasını taşıyamaz, yalnızca geliştirme içindir.
     *
     * Gerçek GCS uygulaması ve bucket retention policy'si **Faz 13**'e aittir
     * (R-82). Bu yüzden production'da dışa aktarım zorunlu tutulmaz; zorunlu olan
     * doğrulamadır.
     */
    AUDIT_ARCHIVE_PROVIDER: z.enum(['memory', 'gcs']).default('memory'),
    /**
     * Arşiv nesnesinin silinemeyeceği süre (gün).
     * TODO(legal): denetim izi saklama süresi hukuk görüşüyle kesinleşecek (A-04).
     */
    AUDIT_EXPORT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(3650),
    /**
     * Retention-locked arşiv bucket'ı (Faz 13, R-82).
     *
     * Bucket'ın **kilitli** retention policy'si ve object retention özelliği Terraform'da
     * tanımlıdır; uygulama nesneyi yazarken üzerine yazmayı önler ve nesne bazlı
     * saklama süresi ayarlar. `gcs` sağlayıcısında zorunludur.
     */
    AUDIT_ARCHIVE_BUCKET: z.string().min(1).optional(),

    /**
     * Retention silme işi (T-24). Kapalıyken hiçbir veri otomatik silinmez.
     *
     * Saklama süreleri docs/security/data-retention-inventory.md ile aynı
     * kaynaktan gelir; TODO(legal) işaretli süreler hukuk görüşüyle kesinleşecek.
     */
    RETENTION_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    RETENTION_INTERVAL_MS: z.coerce.number().int().min(1000).default(3600000),
    RETENTION_BATCH_SIZE: z.coerce.number().int().min(1).max(10000).default(500),
    /** Kapatılmış hesabın anonimleştirilmesine kadar geçen süre (KVKK, R-38). */
    RETENTION_DELETED_USER_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
    /** İşlenmiş event tekilleştirme kayıtları; teslim penceresinden uzun olmalı. */
    RETENTION_PROCESSED_EVENT_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    /** Çözülmüş dead-letter kayıtları. */
    RETENTION_DEAD_LETTER_DAYS: z.coerce.number().int().min(1).max(365).default(90),
    /** Doğrulama denemesi kayıtları (brute-force analizi için gereken süre kadar). */
    RETENTION_VERIFICATION_ATTEMPT_DAYS: z.coerce.number().int().min(1).max(3650).default(180),
    /** Dışa aktarılmış analytics event'leri; BigQuery kanonik kopyadır. */
    RETENTION_ANALYTICS_EVENT_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  })
  .superRefine((env, ctx) => {
    // --- Ortamdan bağımsız tutarlılık kuralları ---
    // Bir sağlayıcı seçildiyse onun çalışması için gereken değer de verilmelidir;
    // eksikliği ilk isteğe kadar saklamak, hatayı üretimde kanıt akışının ortasında
    // ortaya çıkarırdı.
    if (env.IDENTITY_HASH_KEY_SOURCE === 'kms' && env.IDENTITY_KMS_KEY_NAME === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['IDENTITY_KMS_KEY_NAME'],
        message: 'IDENTITY_HASH_KEY_SOURCE=kms iken IDENTITY_KMS_KEY_NAME zorunludur',
      });
    }

    if (
      env.IDENTITY_KMS_KEY_NAME !== undefined &&
      !/^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+\/cryptoKeyVersions\/[^/]+$/.test(
        env.IDENTITY_KMS_KEY_NAME,
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['IDENTITY_KMS_KEY_NAME'],
        message:
          'IDENTITY_KMS_KEY_NAME tam sürüm kaynak adı olmalı (.../cryptoKeyVersions/<n>): ' +
          'primary sürüme bırakmak anahtarın sessizce değişmesine yol açar (ADR-0004 §5)',
      });
    }

    // TLS'li bir Redis adresi CA olmadan bağlanamaz; bunu ilk komuta kadar
    // saklamak, servisin "redis down" raporlayarak hazır olmamasına yol açardı.
    if (env.REDIS_URL.startsWith('rediss://') && env.REDIS_CA_CERT === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_CA_CERT'],
        message: 'rediss:// adresi için REDIS_CA_CERT zorunludur (Memorystore kendi CA.sını sunar)',
      });
    }

    if (env.AUDIT_ARCHIVE_PROVIDER === 'gcs' && env.AUDIT_ARCHIVE_BUCKET === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUDIT_ARCHIVE_BUCKET'],
        message: 'AUDIT_ARCHIVE_PROVIDER=gcs iken AUDIT_ARCHIVE_BUCKET zorunludur',
      });
    }

    // --- Dağıtılan ortamların sertleştirme kuralları ---
    //
    // Kurallar **staging'i de** kapsar (Faz 13, ADR-0023 §1). Staging'in işi
    // production ile aynı kod yollarını çalıştırmaktır; sahte sağlayıcılarla ayağa
    // kalkabilen bir staging, production'a çıkmadan önce hiçbir şeyi kanıtlamaz —
    // ve elle değiştirilen tek bir ortam değişkeni onu sessizce oraya düşürebilirdi.
    // Tek savunmanın dağıtım **sonrası** smoke testi olması geç kalmaktır.
    const isDeployedEnvironment = env.NODE_ENV === 'production' || env.NODE_ENV === 'staging';
    if (!isDeployedEnvironment) {
      return;
    }

    for (const key of ['IDENTITY_PROVIDER', 'PAYMENT_PROVIDER', 'AUTH_PROVIDER'] as const) {
      if (env[key] === 'mock') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key}=mock dağıtılan ortamlarda (staging/production) kullanılamaz`,
        });
      }
    }

    // Firebase token doğrulaması audience/issuer olarak proje kimliğini kullanır;
    // yerel varsayılanla production'a çıkmak tüm token'ları geçersiz kılar (ADR-0016).
    if (env.AUTH_PROVIDER === 'firebase' && env.FIREBASE_PROJECT_ID === 'emek-local') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FIREBASE_PROJECT_ID'],
        message: 'FIREBASE_PROJECT_ID dağıtılan ortamlarda gerçek proje kimliği olmalı',
      });
    }

    if (env.IDENTITY_HASH_KEY_SOURCE !== 'kms') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['IDENTITY_HASH_KEY_SOURCE'],
        message:
          'IDENTITY_HASH_KEY_SOURCE dağıtılan ortamlarda (staging/production) kms olmalı (ADR-0004)',
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
          message: `${key} dağıtılan ortamlarda (staging/production) yerel varsayılan değeri olamaz`,
        });
      }
    }

    // Mock storage bellekte tutar ve süreç yeniden başladığında kanıtları kaybeder;
    // "dijital ispat" iddiası bununla taşınamaz.
    if (env.STORAGE_PROVIDER !== 'gcs') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STORAGE_PROVIDER'],
        message: 'STORAGE_PROVIDER dağıtılan ortamlarda (staging/production) gcs olmalı',
      });
    }

    // Cloud Run arkasında proxy sayısı ayarlanmazsa IP bazlı oran sınırı tek global
    // kovaya çöker: tek bir istemci tüm kullanıcıların kotasını tüketir (R-53).
    if (env.TRUSTED_PROXY_HOP_COUNT === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TRUSTED_PROXY_HOP_COUNT'],
        message:
          'TRUSTED_PROXY_HOP_COUNT dağıtılan ortamlarda açıkça ayarlanmalı — ADR-0022. ' +
          'Cloud Run için doğru değer ölçülmeden bilinemez (A-10); fazla bir değer ' +
          'fail-open olduğu için güvenli başlangıç 1.',
      });
    }

    // App Check kapalıyken istemci bütünlüğü iddiası yoktur; production'da zorunlu.
    if (!env.APP_CHECK_ENABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['APP_CHECK_ENABLED'],
        message: 'APP_CHECK_ENABLED dağıtılan ortamlarda true olmalı (ADR-0022)',
      });
    }

    if (env.APP_CHECK_PROVIDER === 'mock') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['APP_CHECK_PROVIDER'],
        message: 'APP_CHECK_PROVIDER=mock dağıtılan ortamlarda kullanılamaz',
      });
    }

    if (env.APP_CHECK_ENABLED && env.FIREBASE_PROJECT_NUMBER === '000000000000') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FIREBASE_PROJECT_NUMBER'],
        message: 'FIREBASE_PROJECT_NUMBER dağıtılan ortamlarda gerçek proje numarası olmalı',
      });
    }

    // Zincir tamper-evident'tır: kimse bakmazsa kopukluk görünmez.
    if (!env.AUDIT_VERIFICATION_ENABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUDIT_VERIFICATION_ENABLED'],
        message: 'AUDIT_VERIFICATION_ENABLED dağıtılan ortamlarda true olmalı (ADR-0013 §8)',
      });
    }

    if (env.AUDIT_EXPORT_ENABLED && env.AUDIT_ARCHIVE_PROVIDER === 'memory') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUDIT_ARCHIVE_PROVIDER'],
        message:
          'AUDIT_ARCHIVE_PROVIDER=memory ile dışa aktarım dağıtılan ortamlarda anlamsızdır (R-82)',
      });
    }

    // Belgelenmiş saklama süresi, uygulanmayan saklama süresidir (T-24, R-38).
    if (!env.RETENTION_ENABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RETENTION_ENABLED'],
        message: 'RETENTION_ENABLED dağıtılan ortamlarda true olmalı (KVKK, R-38)',
      });
    }

    // AI servisi yalnızca ağ yapılandırmasına güvenemez (Faz 6 review bulgusu L1).
    if (env.AI_SERVICE_API_KEY === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AI_SERVICE_API_KEY'],
        message: 'AI_SERVICE_API_KEY dağıtılan ortamlarda tanımlı olmalı',
      });
    }

    // R-82 kapanışı (Faz 13): gerçek, retention-locked arşiv bağlandı. Artık
    // "doğrulanmış zincirin bağımsız kopyası" iddiası taşınabilir — ve taşınmak
    // zorundadır: veritabanına tam erişimi olan bir saldırgan karşısında zincirin
    // tek kopyası aynı veritabanındaysa doğrulama hiçbir şey kanıtlamaz.
    if (!env.AUDIT_EXPORT_ENABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUDIT_EXPORT_ENABLED'],
        message: 'AUDIT_EXPORT_ENABLED dağıtılan ortamlarda true olmalı (ADR-0013 §8, R-82)',
      });
    }

    if (env.AUDIT_ARCHIVE_PROVIDER !== 'gcs') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUDIT_ARCHIVE_PROVIDER'],
        message:
          'AUDIT_ARCHIVE_PROVIDER dağıtılan ortamlarda (staging/production) gcs olmalı (R-82)',
      });
    }

    // Event transport'u production'da gerçek olmalı: 'logging' event'i hiçbir yere
    // yayınlamaz, ama outbox kaydını "yayınlandı" diye işaretler (ADR-0010).
    if (env.EVENT_TRANSPORT_TYPE !== 'pubsub') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EVENT_TRANSPORT_TYPE'],
        message:
          'EVENT_TRANSPORT_TYPE dağıtılan ortamlarda (staging/production) pubsub olmalı (ADR-0010)',
      });
    }

    if (env.PUBSUB_EMULATOR_HOST !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PUBSUB_EMULATOR_HOST'],
        message: 'PUBSUB_EMULATOR_HOST dağıtılan ortamlarda tanımlı olamaz',
      });
    }

    // ADR-0021: export açıkken bellek-içi sahte sağlayıcıyla üretime çıkmak,
    // "BigQuery'ye export ediliyor" iddiasını hiçbir yere yazmadan doğru gösterir.
    if (env.ANALYTICS_EXPORT_ENABLED && env.BIGQUERY_PROVIDER !== 'bigquery') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BIGQUERY_PROVIDER'],
        message:
          'ANALYTICS_EXPORT_ENABLED=true iken BIGQUERY_PROVIDER dağıtılan ortamlarda bigquery olmalı',
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
