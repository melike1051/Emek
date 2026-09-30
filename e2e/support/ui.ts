import { expect, type Page } from '@playwright/test';
import type { Actor } from './seed';

/**
 * Geliştirici (mock) girişi — web ve admin aynı formu kullanır. Token `sessionStorage`'da
 * tutulur; her Playwright bağlamı ayrı bir tarayıcı oturumudur.
 */
export async function signIn(page: Page, actor: Pick<Actor, 'subject' | 'phoneLocal'>, path = '/') {
  await page.goto(path);
  await expect(page).toHaveURL(/\/giris/);
  await page.getByLabel('Geliştirici kimliği').fill(actor.subject);
  await page.getByLabel('Cep telefonu').fill(actor.phoneLocal);
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  await expect(page).not.toHaveURL(/\/giris/);
}
