import { defineConfig, devices } from '@playwright/test';

/**
 * Faz 15 kritik akış E2E (ADR-0024 §Test). Gerçek core API'ye karşı koşar:
 * `AUTH_PROVIDER=mock`, `PAYMENT_PROVIDER=mock`, `APP_CHECK_ENABLED=false`. Core API'yi bu dosya
 * başlatmaz (migration + seed + env ister); `global-setup.ts` ayakta olduğunu doğrular.
 * Web ve admin gerekirse burada `next dev` ile başlatılır, çalışıyorsa yeniden kullanılır.
 */
const WEB_URL = process.env.E2E_WEB_URL ?? 'http://localhost:3001';
const ADMIN_URL = process.env.E2E_ADMIN_URL ?? 'http://localhost:3004';

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  // Testler aynı yerel veritabanını paylaşır; her test kendi benzersiz verisini üretir.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    ...devices['Desktop Chrome'],
  },
  projects: [
    { name: 'web', testMatch: /web\..*\.spec\.ts/, use: { baseURL: WEB_URL } },
    { name: 'admin', testMatch: /admin\..*\.spec\.ts/, use: { baseURL: ADMIN_URL } },
  ],
  webServer: [
    {
      command: 'npm run dev --workspace=@emek/web',
      cwd: '..',
      url: WEB_URL,
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: 'npm run dev --workspace=@emek/admin',
      cwd: '..',
      url: ADMIN_URL,
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
