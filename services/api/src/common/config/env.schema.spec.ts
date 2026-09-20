import { EnvValidationError, validateEnv } from './env.schema';

const baseEnv = {
  DATABASE_URL: 'postgres://emek:secret@localhost:5432/emek',
  REDIS_URL: 'redis://localhost:6379',
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
    expect(() =>
      validateEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        IDENTITY_PROVIDER: 'mock',
        PAYMENT_PROVIDER: 'live',
      }),
    ).toThrow(/IDENTITY_PROVIDER/);
  });

  it('production + PAYMENT_PROVIDER=mock ile servis başlamaz', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        IDENTITY_PROVIDER: 'live',
        PAYMENT_PROVIDER: 'mock',
      }),
    ).toThrow(/PAYMENT_PROVIDER/);
  });

  it('production ortamında Pub/Sub emulator tanımlı olamaz', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        NODE_ENV: 'production',
        IDENTITY_PROVIDER: 'live',
        PAYMENT_PROVIDER: 'live',
        PUBSUB_EMULATOR_HOST: 'localhost:8085',
      }),
    ).toThrow(/PUBSUB_EMULATOR_HOST/);
  });

  it('gerçek sağlayıcılarla production yapılandırması geçerlidir', () => {
    const env = validateEnv({
      ...baseEnv,
      NODE_ENV: 'production',
      IDENTITY_PROVIDER: 'live',
      PAYMENT_PROVIDER: 'live',
    });

    expect(env.NODE_ENV).toBe('production');
    expect(env.PUBSUB_EMULATOR_HOST).toBeUndefined();
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
