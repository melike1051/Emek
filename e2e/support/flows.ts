import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { bookingStatus, tomorrowUtc, type Actor } from './seed';
import { signIn } from './ui';

/**
 * Birden çok spec'in arayüzden yürüttüğü akış adımları. Her adım gerçek ekrandan geçer;
 * yalnız tekrar yazılmasın diye burada durur.
 */

/**
 * Müşteri ilk girişten eşleşmeye: rol seçimi, adres, form ile talep, "Sağlayıcı bul".
 * Sağlayıcı yarın 06–20 UTC müsait (`seedProvider`); pencere İstanbul saatiyle 11:00–21:00.
 * Rezervasyon sayfasında (`PROVIDER_PENDING`) biter ve rezervasyon kimliğini döner.
 */
export async function customerRequestsAndMatches(
  page: Page,
  customer: Actor,
  location: { latitude: number; longitude: number },
  providerDisplayName: string,
): Promise<string> {
  await signIn(page, customer);
  await expect(page).toHaveURL(/\/rol-sec/);
  await page.getByText('Hizmet almak istiyorum').click();
  await page.getByLabel('Adınız').fill('E2E Müşteri');
  await page.getByRole('button', { name: 'Devam et →' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('güvenilir eller');

  const addressForm = page.getByRole('form', { name: 'Yeni adres' });
  await addressForm.getByLabel('İl', { exact: true }).fill('Ankara');
  await addressForm.getByLabel('İlçe').fill('Çankaya');
  await addressForm.getByLabel('Açık adres').fill('E2E Mahallesi 1. Sokak No 2');
  await addressForm.getByLabel('Enlem').fill(String(location.latitude));
  await addressForm.getByLabel('Boylam').fill(String(location.longitude));
  await addressForm.getByRole('button', { name: 'Adresi kaydet' }).click();
  await expect(page.getByLabel('Hizmet adresi')).toBeVisible();

  await page.getByRole('button', { name: 'Formla oluştur' }).click();
  const form = page.getByRole('form', { name: 'Talep formu' });
  await form.getByLabel('Hizmet').selectOption({ label: 'Detaylı Temizlik' });
  const day = tomorrowUtc(12).toISOString().slice(0, 10);
  await form.getByLabel('Tarih').fill(day);
  await form.getByLabel('Süre (dakika)').fill('180');
  await form.getByLabel('En erken başlangıç').fill('11:00');
  await form.getByLabel('En geç bitiş').fill('21:00');
  await form.getByRole('button', { name: 'Talebi oluştur' }).click();

  await expect(page).toHaveURL(/\/talep\/[0-9a-f-]{36}$/);
  await expect(page.getByText('180 dakika')).toBeVisible();
  await page.getByRole('button', { name: 'Sağlayıcı bul' }).click();

  await expect(page).toHaveURL(/\/eslesme$/);
  await expect(page.getByRole('heading', { name: providerDisplayName })).toBeVisible();
  // AI motoru ayaktaysa gerekçeler, değilse yedek yolun (açıklamasız) sınırlı-mod uyarısı.
  await expect(
    page.getByText('Neden bu sağlayıcı?').or(page.getByText('Eşleştirme sınırlı modda yapıldı')),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Randevuya git' }).click();
  await expect(page).toHaveURL(/\/randevular\/[0-9a-f-]{36}$/);
  const bookingId = page.url().split('/').pop()!;
  await expect(page.getByText('Sağlayıcı onayı bekleniyor').first()).toBeVisible();
  expect(await bookingStatus(bookingId)).toBe('PROVIDER_PENDING');
  return bookingId;
}

/** Sağlayıcı ayrı bir tarayıcı oturumunda randevuyu kabul eder (`CONFIRMED`). */
export async function providerAccepts(
  browser: Browser,
  provider: Actor,
  bookingId: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, provider);
  await page.goto(`/panel/randevular/${bookingId}`);
  await page.getByRole('button', { name: 'Randevuyu kabul et' }).click();
  await page.getByRole('button', { name: 'Evet, kabul ediyorum' }).click();
  await expect.poll(() => bookingStatus(bookingId)).toBe('CONFIRMED');
  return { context, page };
}

/** Müşteri ödemeyi onaylar: mock PSP senkron döner → `SCHEDULED`, tutar `HELD`. */
export async function customerAuthorizesPayment(page: Page, bookingId: string): Promise<void> {
  await page.reload();
  const pay = page.getByRole('button', { name: /ödemeyi onayla$/ });
  await expect(pay).toBeVisible();
  await pay.click();
  // Yetki alındıktan sonra tutar hizmet tamamlanana kadar tutulur (HELD); para çıkmaz.
  await expect(page.getByText('Güvende tutuluyor')).toBeVisible();
  await expect(page.getByText('Planlandı').first()).toBeVisible();
  expect(await bookingStatus(bookingId)).toBe('SCHEDULED');
}
