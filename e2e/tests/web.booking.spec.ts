import { expect, test } from '@playwright/test';
import {
  bookingStatus,
  clearRateLimits,
  closeDb,
  randomLocation,
  registerActor,
  seedProvider,
  tomorrowUtc,
} from '../support/seed';
import { signIn } from '../support/ui';

test.beforeEach(clearRateLimits);
test.afterAll(closeDb);

/**
 * Kritik akış (phase-15-plan §4.3–4.4): müşteri ilk girişten ödeme yetkisine kadar, sağlayıcı
 * randevuyu arayüzden kabul eder. Doğal dil ayrıştırması AI servisine bağlı olduğundan akış
 * deterministik form yolundan geçer; ayrıştırıcı kendi servis testleriyle sınanır.
 */
test('müşteri talep → eşleşme → sağlayıcı kabulü → ödeme yetkisi → planlandı', async ({
  browser,
}) => {
  const location = randomLocation();
  const provider = await seedProvider({ state: 'APPROVED', location });
  const customer = await registerActor('customer');

  // --- Müşteri: rol seçimi + adres + form ile talep ---
  const customerContext = await browser.newContext();
  const page = await customerContext.newPage();
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
  // Sağlayıcı yarın 06–20 UTC müsait; pencere İstanbul saatiyle 11:00–21:00 (08–18 UTC).
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
  await expect(page.getByRole('heading', { name: provider.displayName })).toBeVisible();
  // AI motoru ayaktaysa gerekçeler, değilse yedek yolun (açıklamasız) sınırlı-mod uyarısı.
  await expect(
    page.getByText('Neden bu sağlayıcı?').or(page.getByText('Eşleştirme sınırlı modda yapıldı')),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Randevuya git' }).click();
  await expect(page).toHaveURL(/\/randevular\/[0-9a-f-]{36}$/);
  const bookingId = page.url().split('/').pop()!;
  await expect(page.getByText('Sağlayıcı onayı bekleniyor').first()).toBeVisible();
  expect(await bookingStatus(bookingId)).toBe('PROVIDER_PENDING');

  // --- Sağlayıcı: randevuyu arayüzden kabul eder ---
  const providerContext = await browser.newContext();
  const providerPage = await providerContext.newPage();
  await signIn(providerPage, provider);
  await providerPage.goto(`/panel/randevular/${bookingId}`);
  await providerPage.getByRole('button', { name: 'Randevuyu kabul et' }).click();
  await providerPage.getByRole('button', { name: 'Evet, kabul ediyorum' }).click();
  await expect.poll(() => bookingStatus(bookingId)).toBe('CONFIRMED');

  // --- Müşteri: ödeme yetkisi (mock PSP senkron döner → SCHEDULED) ---
  await page.reload();
  const pay = page.getByRole('button', { name: /ödemeyi onayla$/ });
  await expect(pay).toBeVisible();
  await pay.click();
  // Yetki alındıktan sonra tutar hizmet tamamlanana kadar tutulur (HELD); para çıkmaz.
  await expect(page.getByText('Güvende tutuluyor')).toBeVisible();
  await expect(page.getByText('Planlandı').first()).toBeVisible();
  expect(await bookingStatus(bookingId)).toBe('SCHEDULED');

  // Başka bir müşteri bu randevuyu göremez (sahiplik, deny by default).
  const stranger = await registerActor('stranger');
  const strangerContext = await browser.newContext();
  const strangerPage = await strangerContext.newPage();
  await signIn(strangerPage, stranger);
  await strangerPage.getByText('Hizmet almak istiyorum').click();
  await strangerPage.getByLabel('Adınız').fill('E2E Yabancı');
  await strangerPage.getByRole('button', { name: 'Devam et →' }).click();
  await strangerPage.goto(`/randevular/${bookingId}`);
  await expect(strangerPage.getByText(/bulunamadı|yetkiniz yok/i).first()).toBeVisible();
  await expect(strangerPage.getByText('Güvende tutuluyor')).toHaveCount(0);

  await Promise.all([customerContext.close(), providerContext.close(), strangerContext.close()]);
});
