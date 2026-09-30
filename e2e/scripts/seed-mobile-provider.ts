/**
 * Mobil simülatör testi (apps/mobile/integration_test) için eşleşmeye hazır bir sağlayıcı kurar ve
 * `--dart-define` değerlerini JSON olarak yazar. Web E2E ile aynı seed; yalnız yerel hedeflere
 * yazar (`assertLocalTargets`). Çalıştırma: `npx tsx e2e/scripts/seed-mobile-provider.ts`.
 */
import { clearRateLimits, closeDb, randomLocation, seedProvider } from '../support/seed';

async function main(): Promise<void> {
  await clearRateLimits();
  const location = randomLocation();
  const provider = await seedProvider({ state: 'APPROVED', location });
  process.stdout.write(
    JSON.stringify({
      E2E_LAT: String(location.latitude),
      E2E_LON: String(location.longitude),
      E2E_PROVIDER_SUBJECT: provider.subject,
      E2E_PROVIDER_NAME: provider.displayName,
    }) + '\n',
  );
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => void closeDb());
