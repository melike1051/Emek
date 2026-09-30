import { expect, test } from '@playwright/test';
import {
  bookingStatus,
  clearRateLimits,
  closeDb,
  grantRole,
  matchingRunFor,
  outboxEventTypes,
  paymentStatus,
  randomLocation,
  registerActor,
  reviewsFor,
  safetyState,
  seedProvider,
  sendTelemetry,
  statusHistory,
  verifyAuditChain,
} from '../support/seed';
import {
  customerAuthorizesPayment,
  customerRequestsAndMatches,
  providerAccepts,
} from '../support/flows';
import { signIn } from '../support/ui';

test.beforeEach(clearRateLimits);
test.afterAll(closeDb);

const ADMIN_URL = process.env.E2E_ADMIN_URL ?? 'http://localhost:3004';
const FALLBACK_ALGORITHM_VERSION = 'fallback-distance-v1';

/**
 * Faz 17 final E2E (test-strategy.md §E2E): customer → booking → matching → payment → service →
 * safety → review → settlement tek senaryoda, üç aktör (müşteri, sağlayıcı, operatör) ve üç
 * arayüzle. Telemetri dışındaki her kullanıcı adımı ekrandan geçer; telemetri mobil
 * istemcinin işidir ve aynı uca doğrudan gönderilir.
 *
 * `E2E_REQUIRE_AI=true` iken (CI'daki AI'lı varyant) eşleşmenin yedek yoldan geçmediği de
 * doğrulanır: açıklanabilirlik zinciri uçtan uca sınanır (R-106).
 */
test('talep → eşleşme → ödeme → hizmet günü + telemetri → onay → değerlendirme → mutabakat', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const location = randomLocation();
  const provider = await seedProvider({ state: 'APPROVED', location });
  const customer = await registerActor('customer');
  const admin = await registerActor('admin');
  await grantRole(admin, 'ADMIN');

  // --- 1. Talep + eşleşme + kabul + ödeme yetkisi ---
  const customerContext = await browser.newContext();
  const page = await customerContext.newPage();
  const bookingId = await customerRequestsAndMatches(
    page,
    customer,
    location,
    provider.displayName,
  );

  const matching = await matchingRunFor(bookingId);
  expect(matching?.algorithmVersion).toBeTruthy();
  if (process.env.E2E_REQUIRE_AI === 'true') {
    expect(matching?.algorithmVersion).not.toBe(FALLBACK_ALGORITHM_VERSION);
    await expect(page.getByText('Eşleştirme sınırlı modda yapıldı')).toHaveCount(0);
  }

  const providerSide = await providerAccepts(browser, provider, bookingId);
  await customerAuthorizesPayment(page, bookingId);
  expect(await paymentStatus(bookingId)).toBe('HELD');
  expect(await safetyState(bookingId)).toEqual({ riskLevel: 'NORMAL', panicCount: 0 });

  // --- 2. Hizmet günü: sağlayıcı adımları arayüzden, telemetri cihazdan ---
  const providerPage = providerSide.page;
  await providerPage.reload();
  const steps = [
    { label: 'Yola çıktım', confirm: 'Evet, yola çıkıyorum', status: 'PROVIDER_ARRIVING' },
    { label: 'Adrese vardım', confirm: 'Evet, adresteyim', status: 'CHECKED_IN' },
    { label: 'Hizmeti başlat', confirm: 'Evet, başlıyorum', status: 'IN_PROGRESS' },
    { label: 'Hizmeti bitirdim', confirm: 'Evet, hizmet bitti', status: 'CHECKED_OUT' },
  ] as const;
  for (const step of steps) {
    await providerPage.getByRole('button', { name: step.label }).click();
    await providerPage.getByRole('button', { name: step.confirm }).click();
    await expect.poll(() => bookingStatus(bookingId)).toBe(step.status);

    // Telemetri yalnız aktif hizmet oturumunda kabul edilir (CLAUDE.md §4 Safety).
    if (step.status === 'IN_PROGRESS') {
      const telemetry = await sendTelemetry(provider, bookingId, location);
      expect(telemetry.sessionStatus).toBe('ACTIVE');
      expect(telemetry.results).toEqual([{ status: 'ACCEPTED', reason: null, sequence: 1 }]);
    }
  }
  // Check-out oturumu kapatır; hizmet boyunca risk yükselmedi.
  expect(await safetyState(bookingId)).toEqual({ riskLevel: 'NORMAL', panicCount: 0 });

  // --- 3. Müşteri onayı → COMPLETED; para hâlâ tutulur (uyuşmazlık penceresi) ---
  await page.reload();
  await page.getByRole('button', { name: 'Hizmeti onayla' }).click();
  await page.getByRole('button', { name: 'Evet, hizmet tamamlandı' }).click();
  await expect.poll(() => bookingStatus(bookingId)).toBe('COMPLETED');
  expect(await paymentStatus(bookingId)).toBe('SERVICE_COMPLETED');

  // --- 4. Değerlendirme ---
  const review = page.getByRole('form', { name: 'Değerlendirme' });
  await review.getByRole('radio', { name: '5 yıldız' }).click();
  await review.getByLabel('Yorumunuz (isteğe bağlı)').fill('E2E: özenli ve zamanında.');
  await review.getByRole('button', { name: 'Gönder' }).click();
  await expect(page.getByText('Değerlendirmeniz için teşekkürler.')).toBeVisible();
  expect(await reviewsFor(bookingId)).toEqual([{ rating: 5, authorId: customer.userId }]);

  // --- 5. Operatör ödemeyi serbest bırakır → SETTLED ---
  const adminContext = await browser.newContext({ baseURL: ADMIN_URL });
  const adminPage = await adminContext.newPage();
  await signIn(adminPage, admin, `/odemeler?bookingId=${bookingId}`);
  await adminPage.getByRole('button', { name: 'Serbest bırak', exact: true }).click();
  const release = adminPage.getByRole('group', { name: /sağlayıcıya serbest bırakılsın mı\?$/ });
  await release
    .getByLabel('Uyuşmazlık penceresinin geçtiğini ve hizmetin tamamlandığını kontrol ettim.')
    .check();
  await release.getByRole('button', { name: 'Serbest bırak', exact: true }).click();
  await expect.poll(() => bookingStatus(bookingId)).toBe('SETTLED');
  expect(await paymentStatus(bookingId)).toBe('RELEASED');

  // --- 6. Kalıcı iz: tam durum zinciri, eventler, audit zinciri ---
  expect(await statusHistory(bookingId)).toEqual([
    'REQUESTED',
    'MATCHED',
    'PROVIDER_PENDING',
    'CONFIRMED',
    'PAYMENT_AUTHORIZED',
    'SCHEDULED',
    'PROVIDER_ARRIVING',
    'CHECKED_IN',
    'IN_PROGRESS',
    'CHECKED_OUT',
    'CUSTOMER_CONFIRMED',
    'COMPLETED',
    'SETTLED',
  ]);
  expect(await outboxEventTypes(bookingId)).toEqual(
    expect.arrayContaining([
      'BookingConfirmed',
      'PaymentAuthorized',
      'ServiceStarted',
      'ServiceCompleted',
      'PaymentReleased',
    ]),
  );
  expect(await verifyAuditChain(admin)).toEqual(expect.objectContaining({ status: 'OK' }));

  await Promise.all([customerContext.close(), providerSide.context.close(), adminContext.close()]);
});
