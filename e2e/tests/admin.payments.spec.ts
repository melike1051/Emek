import { expect, test } from '@playwright/test';
import {
  clearRateLimits,
  closeDb,
  grantRole,
  paymentRefundedMinor,
  registerActor,
  seedScheduledBooking,
} from '../support/seed';
import { signIn } from '../support/ui';

test.beforeEach(clearRateLimits);
test.afterAll(closeDb);

/**
 * Adım 5 orta bulgusu: yanıtı kaybolan iade tekrar denendiğinde ikinci kez para iade etmemeli.
 * İlk istek sunucuda işlenir ama tarayıcı yanıtı alamaz (ağ hatası). Panel kilitlenir, tekrar
 * deneme aynı gövde + aynı `Idempotency-Key` ile gider ve backend kaydı tekrar oynatır.
 */
test('kaybolan yanıttan sonra iade paneli kilitlenir ve tekrar deneme tek iade üretir', async ({
  page,
}) => {
  const { bookingId } = await seedScheduledBooking();
  const admin = await registerActor('admin');
  await grantRole(admin, 'ADMIN');

  const keys: string[] = [];
  let dropped = false;
  await page.route('**/api/v1/payments/*/refund', async (route) => {
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    if (!dropped) {
      dropped = true;
      // İstek sunucuya ulaşır ve işlenir; yanıt tarayıcıya hiç dönmez.
      await route.fetch();
      await route.abort('failed');
      return;
    }
    await route.continue();
  });

  await signIn(page, admin, `/odemeler?bookingId=${bookingId}`);
  await page.getByRole('button', { name: 'İade et', exact: true }).click();
  const panel = page.getByRole('group', { name: 'İade' });
  await panel.getByLabel('Tutar (₺, isteğe bağlı)').fill('100,00');
  await panel.getByLabel('İade gerekçesi').fill('E2E kısmi iade');
  await panel.getByLabel('İade müşteriye geri ödenir ve geri alınamaz.').check();
  await panel.getByRole('button', { name: 'İade et', exact: true }).click();

  await expect(panel.getByText('Bilgiler kilitlendi')).toBeVisible();
  await expect(panel.getByLabel('İade gerekçesi')).toBeDisabled();
  await expect(panel.getByLabel('Tutar (₺, isteğe bağlı)')).toBeDisabled();
  expect(await paymentRefundedMinor(bookingId)).toBe('10000');

  await panel.getByRole('button', { name: 'Tekrar dene' }).click();
  await expect(panel).toHaveCount(0);

  expect(keys).toHaveLength(2);
  expect(keys[0]).toMatch(/.{16,}/);
  expect(keys[1]).toBe(keys[0]);
  expect(await paymentRefundedMinor(bookingId)).toBe('10000');
});
