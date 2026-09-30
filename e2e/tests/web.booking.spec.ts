import { expect, test } from '@playwright/test';
import {
  clearRateLimits,
  closeDb,
  randomLocation,
  registerActor,
  seedProvider,
} from '../support/seed';
import {
  customerAuthorizesPayment,
  customerRequestsAndMatches,
  providerAccepts,
} from '../support/flows';
import { signIn } from '../support/ui';

test.beforeEach(clearRateLimits);
test.afterAll(closeDb);

/**
 * Kritik akış (phase-15-plan §4.3–4.4): müşteri ilk girişten ödeme yetkisine kadar, sağlayıcı
 * randevuyu arayüzden kabul eder. Doğal dil ayrıştırması AI servisine bağlı olduğundan akış
 * deterministik form yolundan geçer; ayrıştırıcı kendi servis testleriyle sınanır.
 * Hizmet günü → onay → değerlendirme → mutabakat zinciri `web.full-lifecycle.spec.ts`'tedir.
 */
test('müşteri talep → eşleşme → sağlayıcı kabulü → ödeme yetkisi → planlandı', async ({
  browser,
}) => {
  const location = randomLocation();
  const provider = await seedProvider({ state: 'APPROVED', location });
  const customer = await registerActor('customer');

  const customerContext = await browser.newContext();
  const page = await customerContext.newPage();
  const bookingId = await customerRequestsAndMatches(
    page,
    customer,
    location,
    provider.displayName,
  );
  const providerSide = await providerAccepts(browser, provider, bookingId);
  await customerAuthorizesPayment(page, bookingId);

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

  await Promise.all([
    customerContext.close(),
    providerSide.context.close(),
    strangerContext.close(),
  ]);
});
