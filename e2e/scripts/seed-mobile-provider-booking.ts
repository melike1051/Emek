/**
 * Mobil sağlayıcı akışı simülatör testi için sağlayıcı onayı bekleyen bir randevu kurar ve
 * `--dart-define` değerlerini JSON yazar (yalnız yerel hedefler). Kökten:
 * `npx tsx e2e/scripts/seed-mobile-provider-booking.ts`.
 */
import { clearRateLimits, closeDb, seedPendingBooking } from '../support/seed';

async function main(): Promise<void> {
  await clearRateLimits();
  const { bookingId, customer, provider, location } = await seedPendingBooking();
  process.stdout.write(
    JSON.stringify({
      E2E_PENDING_BOOKING_ID: bookingId,
      E2E_PENDING_PROVIDER_SUBJECT: provider.subject,
      E2E_PENDING_PROVIDER_PHONE: provider.phoneLocal,
      E2E_PENDING_CUSTOMER_SUBJECT: customer.subject,
      // Hizmet adresi — simülatör konumu buraya ayarlanır (telemetri testi).
      E2E_PENDING_LAT: String(location.latitude),
      E2E_PENDING_LON: String(location.longitude),
    }) + '\n',
  );
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => void closeDb());
