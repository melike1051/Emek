/**
 * TÜBİTAK demo verisi (Faz 17, `docs/research/demo-scenarios.md`). Her senaryonun aktörlerini
 * ve randevularını kurar, geliştirici (mock) girişi için kimlik + telefonu yazdırır. Web E2E ile
 * aynı seed'dir: yalnız yerel hedeflere yazar (`assertLocalTargets`), üretim/staging'e
 * yönelemez. Her koşu yeni aktörler üretir; eski demo verisi silinmez.
 *
 * Çalıştırma (kökten): `npx tsx e2e/scripts/seed-demo.ts`
 */
import {
  clearRateLimits,
  closeDb,
  grantRole,
  registerActor,
  seedPendingBooking,
  seedProvider,
  seedScheduledBooking,
  type Actor,
} from '../support/seed';

/** Kızılay, Ankara — canlı akışta adres formuna yazılacak konum. */
const LIVE_LOCATION = { latitude: 39.92077, longitude: 32.85411 };

function login(role: string, actor: Pick<Actor, 'subject' | 'phoneLocal'>): string {
  return `  ${role.padEnd(22)} kimlik: ${actor.subject.padEnd(28)} telefon: ${actor.phoneLocal}`;
}

async function main(): Promise<void> {
  await clearRateLimits();

  const admin = await registerActor('demo-admin');
  await grantRole(admin, 'ADMIN');
  const liveProvider = await seedProvider({ state: 'APPROVED', location: LIVE_LOCATION });
  const liveCustomer = await registerActor('demo-customer');
  const applicant = await seedProvider({ state: 'PENDING_REVIEW' });
  const pending = await seedPendingBooking();
  const scheduled = await seedScheduledBooking();

  const lines = [
    'Emek demo verisi hazır. Web: http://localhost:3001  Admin: http://localhost:3004',
    '',
    'Operatör (tüm senaryolar, admin paneli)',
    login('ADMIN', admin),
    '',
    `S1 Canlı akış — adres: Ankara / Çankaya, enlem ${LIVE_LOCATION.latitude}, boylam ${LIVE_LOCATION.longitude}`,
    login('Müşteri (yeni hesap)', liveCustomer),
    login(`Sağlayıcı (${liveProvider.displayName})`, liveProvider),
    '',
    'S2 Sağlayıcı başvurusu — admin "Sağlayıcılar" ekranında incelemede',
    login('Başvuran sağlayıcı', applicant),
    '',
    `S3 Onay bekleyen randevu — /panel/randevular/${pending.bookingId}`,
    login('Sağlayıcı', pending.provider),
    login('Müşteri', pending.customer),
    '',
    `S4 Planlanmış randevu (ödeme tutuluyor) — güvenlik: /randevular/${scheduled.bookingId}/guvenlik`,
    login('Müşteri', scheduled.customer),
    login('Sağlayıcı', scheduled.provider),
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => void closeDb());
