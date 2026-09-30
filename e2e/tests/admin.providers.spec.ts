import { expect, test } from '@playwright/test';
import {
  clearRateLimits,
  closeDb,
  grantRole,
  providerState,
  registerActor,
  seedProvider,
} from '../support/seed';
import { signIn } from '../support/ui';

test.beforeEach(clearRateLimits);
test.afterAll(closeDb);

test('ADMIN bekleyen başvuruyu onaylar (Idempotency-Key ile) ve kayıt APPROVED olur', async ({
  page,
}) => {
  const provider = await seedProvider({ state: 'PENDING_REVIEW' });
  const admin = await registerActor('admin');
  await grantRole(admin, 'ADMIN');

  await signIn(page, admin, '/saglayicilar');
  await expect(page).toHaveURL(/\/saglayicilar/);
  // Başvuru kartı: başlığın eylem düğmesi içeren en yakın atası.
  const card = page
    .getByRole('heading', { name: provider.displayName })
    .locator('xpath=ancestor::*[.//button][1]');
  await expect(card).toBeVisible();

  const approve = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      request.url().includes(`/providers/${provider.userId}/approve`),
  );
  await card.getByRole('button', { name: 'Onayla', exact: true }).click();
  await card
    .getByRole('group', { name: 'Başvuruyu onayla' })
    .getByRole('button', { name: 'Onayla', exact: true })
    .click();
  expect((await approve).headers()['idempotency-key']).toMatch(/.{16,}/);

  await expect.poll(() => providerState(provider.userId)).toBe('APPROVED');
  await expect(page.getByRole('heading', { name: provider.displayName })).toHaveCount(0);
});

test('SUPPORT kuyruğu okur ama yazma eylemi görmez', async ({ page }) => {
  const provider = await seedProvider({ state: 'PENDING_REVIEW' });
  const support = await registerActor('support');
  await grantRole(support, 'SUPPORT');

  await signIn(page, support, '/saglayicilar');
  await expect(page.getByRole('heading', { name: provider.displayName })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Onayla' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reddet' })).toHaveCount(0);
});

test('operatör rolü olmayan kullanıcı admin uygulamasına giremez', async ({ page }) => {
  const customer = await registerActor('noop');
  await page.goto('/');
  await page.getByLabel('Geliştirici kimliği').fill(customer.subject);
  await page.getByLabel('Cep telefonu').fill(customer.phoneLocal);
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  await expect(page.getByRole('heading', { name: 'Sağlayıcılar' })).toHaveCount(0);
  await expect(page.getByText('Bu alan operasyon ekibine özeldir')).toBeVisible();
});
