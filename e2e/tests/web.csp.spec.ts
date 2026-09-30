import { expect, test } from '@playwright/test';
import { expectNonceCsp } from '../support/csp';

/** R-105: web uygulaması nonce'lu CSP ile çalışır; nonce her istekte yenidir. */
test('web: istek başına nonce, satır içi script izni yok, CSP ihlali yok', async ({ browser }) => {
  const first = await browser.newPage();
  const nonce = await expectNonceCsp(first, '/giris');
  await expect(first.getByRole('button', { name: 'Giriş yap' })).toBeVisible();

  const second = await browser.newPage();
  expect(await expectNonceCsp(second, '/giris')).not.toBe(nonce);
  await Promise.all([first.close(), second.close()]);
});
