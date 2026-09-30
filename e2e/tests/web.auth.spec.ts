import { expect, test } from '@playwright/test';
import { clearRateLimits, randomPhone, uniqueSubject } from '../support/seed';

test.beforeEach(clearRateLimits);

test.describe('web — oturum kapısı', () => {
  test('oturumsuz korumalı sayfa girişe yönlenir, giriş sonrası hedefe döner', async ({ page }) => {
    await page.goto('/hesap');
    await expect(page).toHaveURL(/\/giris\?next=%2Fhesap/);

    // Yeni kullanıcı: profil yok → önce rol seçimi.
    await page.getByLabel('Geliştirici kimliği').fill(uniqueSubject('auth'));
    await page.getByLabel('Cep telefonu').fill(randomPhone().local);
    await page.getByRole('button', { name: 'Giriş yap' }).click();
    await expect(page).toHaveURL(/\/(rol-sec|hesap)/);
  });

  test('dış adrese açık yönlendirme yapılmaz', async ({ page }) => {
    await page.goto('/giris?next=https%3A%2F%2Fevil.example%2F');
    await page.getByLabel('Geliştirici kimliği').fill(uniqueSubject('redir'));
    await page.getByLabel('Cep telefonu').fill(randomPhone().local);
    await page.getByRole('button', { name: 'Giriş yap' }).click();
    await expect(page).not.toHaveURL(/\/giris/);
    expect(new URL(page.url()).host).toBe(new URL(test.info().project.use.baseURL!).host);
  });

  test('geçersiz telefon istemcide reddedilir', async ({ page }) => {
    await page.goto('/giris');
    await page.getByLabel('Geliştirici kimliği').fill(uniqueSubject('phone'));
    await page.getByLabel('Cep telefonu').fill('123');
    await page.getByRole('button', { name: 'Giriş yap' }).click();
    await expect(page.getByText('Geçerli bir cep telefonu girin')).toBeVisible();
    await expect(page).toHaveURL(/\/giris/);
  });
});
