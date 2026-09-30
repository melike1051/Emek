import { expect, test } from '@playwright/test';
import {
  clearRateLimits,
  closeDb,
  providerTransition,
  safetyState,
  seedScheduledBooking,
} from '../support/seed';
import { signIn } from '../support/ui';

test.beforeEach(clearRateLimits);
test.afterAll(closeDb);

/**
 * Panik akışı deterministik ve anlıktır (CLAUDE.md §4 Safety): tek onay, ML beklemez, risk
 * doğrudan EMERGENCY olur. Panik ucu oran sınırı ve `Idempotency-Key` taşımaz (ADR-0008 §3).
 */
test('müşteri acil durum bildirir → oturum EMERGENCY, 112 yönlendirmesi görünür', async ({
  page,
}) => {
  const { bookingId, customer, provider } = await seedScheduledBooking();
  expect(await safetyState(bookingId)).not.toBeNull();

  // PRE_SERVICE: backend paniği reddeder; ekran butonu değil 112 yolunu gösterir.
  await signIn(page, customer);
  await page.goto(`/randevular/${bookingId}/guvenlik`);
  await expect(page.getByText('Hizmet saatinde başlayacak')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Acil durum', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '112’yi ara' })).toBeVisible();

  // Sağlayıcı yola çıkar → ARRIVAL_MONITORING: panik açılır.
  await providerTransition(provider, bookingId, 'PROVIDER_ARRIVING');
  await page.reload();
  await page.getByRole('button', { name: 'Acil durum', exact: true }).click();

  const panic = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/panic'),
  );
  await page.getByRole('button', { name: 'Evet, acil durum bildir' }).click();
  expect((await panic).headers()['idempotency-key']).toBeUndefined();

  await expect(page.getByText('Acil durum kaydınız alındı')).toBeVisible();
  await expect(page.getByRole('link', { name: '112’yi ara' })).toHaveAttribute('href', 'tel:112');
  await expect
    .poll(() => safetyState(bookingId))
    .toEqual({ riskLevel: 'EMERGENCY', panicCount: 1 });
});
