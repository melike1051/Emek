/**
 * Production'da geçerli olması gereken asgari yapılandırma — **tek kopya**.
 *
 * Bu nesne iki test dosyasında ayrı ayrı tanımlıydı ve Faz 12'de yeni zorunlu
 * ayarlar eklendiğinde ikisi ayrıştı: biri güncellendi, diğeri kırıldı. Zorunlu
 * bir ayar eklemek tek bir yeri değiştirmeyi gerektirmeli.
 */
export const productionEnvFixture = {
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
  AI_SERVICE_API_KEY: 'production-grade-ai-service-key',
  // Faz 12 (ADR-0022): proxy güveni, App Check, audit doğrulama ve retention
  // production'da açıkça yapılandırılmak zorundadır.
  TRUSTED_PROXY_HOP_COUNT: '2',
  APP_CHECK_ENABLED: 'true',
  APP_CHECK_PROVIDER: 'firebase',
  FIREBASE_PROJECT_NUMBER: '123456789012',
  AUDIT_VERIFICATION_ENABLED: 'true',
  RETENTION_ENABLED: 'true',
} as const;
