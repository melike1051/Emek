import { EnvValidationError, validateEnv } from './env.schema';

const baseEnv = {
  DATABASE_URL: 'postgres://emek:secret@localhost:5432/emek',
  REDIS_URL: 'redis://localhost:6379',
};

/** Production'da geçerli olması gereken asgari yapılandırma. */
const productionEnv = {
  NODE_ENV: 'production',
  IDENTITY_PROVIDER: 'live',
  PAYMENT_PROVIDER: 'live',
  AUTH_PROVIDER: 'firebase',
  FIREBASE_PROJECT_ID: 'emek-production',
  IDENTITY_HASH_KEY_SOURCE: 'kms',
  IDENTITY_HASH_KEY: 'production-grade-identity-hash-key-value',
  IDENTITY_CALLBACK_SECRET: 'production-grade-callback-secret',
  PAYMENT_WEBHOOK_SECRET: 'production-grade-payment-webhook-secret',
  STORAGE_PROVIDER: 'gcs',
  STORAGE_SIGNING_SECRET: 'production-grade-storage-signing-secret',
};

describe('validateEnv', () => {
  it('varsayılanlarla geçerli bir yapılandırma üretir', () => {
    const env = validateEnv({ ...baseEnv });

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.DATABASE_POOL_MAX).toBe(10);
    expect(env.IDENTITY_PROVIDER).toBe('mock');
  });

  it('sayısal değerleri string ortam değişkeninden dönüştürür', () => {
    const env = validateEnv({ ...baseEnv, PORT: '8080', DATABASE_POOL_MAX: '25' });

    expect(env.PORT).toBe(8080);
    expect(env.DATABASE_POOL_MAX).toBe(25);
  });

  it('DATABASE_URL yoksa başlatmayı reddeder', () => {
    expect(() => validateEnv({ REDIS_URL: baseEnv.REDIS_URL })).toThrow(EnvValidationError);
  });

  it('yanlış şemalı DATABASE_URL reddedilir', () => {
    expect(() => validateEnv({ ...baseEnv, DATABASE_URL: 'mysql://localhost:3306/emek' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('geçersiz PORT reddedilir', () => {
    expect(() => validateEnv({ ...baseEnv, PORT: '70000' })).toThrow(EnvValidationError);
    expect(() => validateEnv({ ...baseEnv, PORT: 'abc' })).toThrow(EnvValidationError);
  });

  it('bilinmeyen NODE_ENV reddedilir', () => {
    expect(() => validateEnv({ ...baseEnv, NODE_ENV: 'prod' })).toThrow(EnvValidationError);
  });

  // ADR-0005 / ADR-0009: mock sağlayıcı production'da devre dışıdır.
  it('production + IDENTITY_PROVIDER=mock ile servis başlamaz', () => {
    expect(() => validateEnv({ ...baseEnv, ...productionEnv, IDENTITY_PROVIDER: 'mock' })).toThrow(
      /IDENTITY_PROVIDER/,
    );
  });

  it('production + PAYMENT_PROVIDER=mock ile servis başlamaz', () => {
    expect(() => validateEnv({ ...baseEnv, ...productionEnv, PAYMENT_PROVIDER: 'mock' })).toThrow(
      /PAYMENT_PROVIDER/,
    );
  });

  // ADR-0009 §7: webhook imzası bu sırla doğrulanır. Yerel varsayılanla production'a
  // çıkmak, imzayı herkesin üretebildiği bir formaliteye çevirirdi.
  it('production ortamında yerel ödeme webhook sırrı reddedilir', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        ...productionEnv,
        PAYMENT_WEBHOOK_SECRET: 'local-development-payment-secret',
      }),
    ).toThrow(/PAYMENT_WEBHOOK_SECRET/);
  });

  // Bellekteki kanıt deposu süreç yeniden başladığında silinir; "dijital ispat"
  // iddiası bununla taşınamaz.
  it('production ortamında mock storage reddedilir', () => {
    expect(() => validateEnv({ ...baseEnv, ...productionEnv, STORAGE_PROVIDER: 'mock' })).toThrow(
      /STORAGE_PROVIDER/,
    );
  });

  it('production ortamında yerel storage imza sırrı reddedilir', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        ...productionEnv,
        STORAGE_SIGNING_SECRET: 'local-development-storage-secret',
      }),
    ).toThrow(/STORAGE_SIGNING_SECRET/);
  });

  it('production ortamında Pub/Sub emulator tanımlı olamaz', () => {
    expect(() =>
      validateEnv({ ...baseEnv, ...productionEnv, PUBSUB_EMULATOR_HOST: 'localhost:8085' }),
    ).toThrow(/PUBSUB_EMULATOR_HOST/);
  });

  it('gerçek sağlayıcılarla production yapılandırması geçerlidir', () => {
    const env = validateEnv({
      ...baseEnv,
      ...productionEnv,
    });

    expect(env.NODE_ENV).toBe('production');
    expect(env.PUBSUB_EMULATOR_HOST).toBeUndefined();
  });

  // ADR-0016: mock token doğrulayıcı production'da kabul edilemez.
  it('production + AUTH_PROVIDER=mock ile servis başlamaz', () => {
    expect(() => validateEnv({ ...baseEnv, ...productionEnv, AUTH_PROVIDER: 'mock' })).toThrow(
      /AUTH_PROVIDER/,
    );
  });

  it('production ortamında yerel Firebase proje kimliği reddedilir', () => {
    expect(() =>
      validateEnv({ ...baseEnv, ...productionEnv, FIREBASE_PROJECT_ID: 'emek-local' }),
    ).toThrow(/FIREBASE_PROJECT_ID/);
  });

  // ADR-0004 §4-5: anahtar KMS'te durur. Ortam değişkenindeki bir anahtarla
  // production'a çıkmak, tekillik kontrolünü kâğıt üzerinde bırakırdı.
  it('production ortamında hash anahtarı kaynağı kms olmalı', () => {
    expect(() =>
      validateEnv({ ...baseEnv, ...productionEnv, IDENTITY_HASH_KEY_SOURCE: 'env' }),
    ).toThrow(/IDENTITY_HASH_KEY_SOURCE/);
  });

  it('production ortamında yerel varsayılan sırlar reddedilir', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        ...productionEnv,
        IDENTITY_CALLBACK_SECRET: 'local-development-callback-secret',
      }),
    ).toThrow(/IDENTITY_CALLBACK_SECRET/);

    expect(() =>
      validateEnv({
        ...baseEnv,
        ...productionEnv,
        IDENTITY_HASH_KEY: 'local-development-identity-hash-key-000',
      }),
    ).toThrow(/IDENTITY_HASH_KEY/);
  });

  it('çok kısa hash anahtarı reddedilir', () => {
    expect(() => validateEnv({ ...baseEnv, IDENTITY_HASH_KEY: 'kisa' })).toThrow(
      /IDENTITY_HASH_KEY/,
    );
  });

  it('hesap kurtarma için varsayılan güvence seviyesi HIGH.tır', () => {
    expect(validateEnv({ ...baseEnv }).RECOVERY_MIN_ASSURANCE).toBe('HIGH');
  });

  it('development ortamında mock sağlayıcılar varsayılandır', () => {
    const env = validateEnv({ ...baseEnv });

    expect(env.AUTH_PROVIDER).toBe('mock');
    expect(env.FIREBASE_PROJECT_ID).toBe('emek-local');
  });

  it('hata mesajı ortam değişkeni değerlerini sızdırmaz', () => {
    const secret = 'super-secret-password';

    try {
      validateEnv({ ...baseEnv, DATABASE_URL: `mysql://user:${secret}@localhost/db` });
      throw new Error('doğrulama hatası beklenmişti');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
