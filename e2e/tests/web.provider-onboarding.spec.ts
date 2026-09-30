import { expect, test } from '@playwright/test';
import {
  clearRateLimits,
  closeDb,
  providerState,
  randomLocation,
  registerActor,
} from '../support/seed';
import { signIn } from '../support/ui';

test.beforeEach(clearRateLimits);
test.afterAll(closeDb);

/** phase-15-plan §4.4: sağlayıcı taslaktan incelemeye kadar yalnız arayüzle ilerler. */
test('sağlayıcı profil → hizmet/beceri → bölge → müsaitlik → başvuru', async ({ page }) => {
  const provider = await registerActor('onboard');
  const location = randomLocation();

  await signIn(page, provider);
  await expect(page).toHaveURL(/\/rol-sec/);
  await page.getByText('Emeğimi sunmak istiyorum').click();
  await page.getByLabel('Görünen adınız').fill('E2E Başvuran');
  await page
    .getByLabel('Kendinizi tanıtın (isteğe bağlı)')
    .fill('On yıllık ev temizliği deneyimi.');
  await page.getByRole('button', { name: 'Devam et →' }).click();
  await expect(page).toHaveURL(/\/panel$/);
  await expect(page.getByRole('button', { name: 'Başvuruyu incelemeye gönder' })).toBeDisabled();

  await page.goto('/panel/hizmetler');
  const service = page.getByRole('button', { name: 'Detaylı Temizlik' });
  await service.click();
  await expect(service).toHaveAttribute('aria-pressed', 'true');
  const skillForm = page.getByRole('form', { name: 'Beceri ekle' });
  await skillForm.getByLabel('Beceri').selectOption({ index: 1 });
  await skillForm.getByRole('button', { name: 'Beceri ekle' }).click();
  await expect(page.getByRole('button', { name: /becerisini kaldır$/ })).toHaveCount(1);

  await page.goto('/panel/bolgeler');
  const areaForm = page.getByRole('form', { name: 'Bölge ekle' });
  await areaForm.getByLabel('Bölge adı').fill('E2E bölge');
  await areaForm.getByLabel('Enlem').fill(String(location.latitude));
  await areaForm.getByLabel('Boylam').fill(String(location.longitude));
  await areaForm.getByRole('button', { name: 'Bölgeyi ekle' }).click();
  await expect(page.getByRole('list', { name: 'Bölgeler' })).toContainText('E2E bölge');

  // Haftanın son günü (Pazar) hep ileridedir — test Pazar gecesi koşmadıkça.
  await page.goto('/panel/musaitlik');
  await page.getByRole('button', { name: 'Saat ekle' }).last().click();
  const windowForm = page.getByRole('form', { name: 'Müsaitlik ekle' });
  await windowForm.getByLabel('Başlangıç').fill('09:00');
  await windowForm.getByLabel('Bitiş').fill('17:00');
  await windowForm.getByRole('button', { name: 'Ekle' }).click();
  await expect(page.getByText('09:00 – 17:00')).toBeVisible();

  await page.goto('/panel');
  const submit = page.getByRole('button', { name: 'Başvuruyu incelemeye gönder' });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect.poll(() => providerState(provider.userId)).toBe('PENDING_REVIEW');
  await expect(page.getByText('İncelemede').first()).toBeVisible();
});
