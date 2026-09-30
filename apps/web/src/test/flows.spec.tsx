import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, vi } from 'vitest';
import RoleSelectPage from '@/app/(auth)/rol-sec/page';
import { LoginScreen } from '@/app/(auth)/giris/LoginScreen';
import { SessionGate } from '@/components/SessionGate';
import { ProviderHome } from '@/app/(app)/panel/ProviderHome';
import {
  CUSTOMER,
  PROFILE_NOT_FOUND,
  FORBIDDEN,
  PROVIDER,
  PROVIDER_SESSION,
  SESSION,
  json,
  mockBackend,
  navigation,
  renderApp,
  router,
} from './harness';

vi.mock('next/navigation', () => import('./navigation-mock').then((m) => m.nextNavigationMock));

beforeEach(() => {
  router.replace.mockReset();
  navigation.pathname = '/';
  navigation.search = new URLSearchParams();
});
afterEach(() => vi.unstubAllGlobals());

describe('SessionGate', () => {
  it('oturum yoksa giriş sayfasına, geri dönüş yolunu taşıyarak yönlendirir', async () => {
    mockBackend({});
    navigation.pathname = '/randevular';
    renderApp(<SessionGate>gizli içerik</SessionGate>, { signedIn: false });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/giris?next=%2Frandevular'));
    expect(screen.queryByText('gizli içerik')).not.toBeInTheDocument();
  });

  it('profili olmayan kullanıcıyı rol seçimine yönlendirir', async () => {
    mockBackend({
      '/auth/session': () => json(SESSION),
      '/customers/me': PROFILE_NOT_FOUND,
      '/providers/me': FORBIDDEN,
    });
    renderApp(<SessionGate>içerik</SessionGate>);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/rol-sec'));
  });

  it('oturum kurulamazsa backend mesajı ve referansıyla hata + tekrar dene gösterir', async () => {
    mockBackend({
      '/auth/session': () =>
        json(
          {
            error: {
              code: 'APP_CHECK_REQUIRED',
              message: 'Uygulama doğrulanamadı.',
              requestId: 'req-9',
            },
          },
          403,
        ),
    });
    renderApp(<SessionGate>içerik</SessionGate>);
    expect(await screen.findByText('Uygulama doğrulanamadı.')).toBeInTheDocument();
    expect(screen.getByText('Referans: req-9')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tekrar dene' })).toBeInTheDocument();
  });

  it('backend 401 dönerse oturum kapatılır ve girişe gidilir', async () => {
    mockBackend({
      '/auth/session': () =>
        json({ error: { code: 'UNAUTHENTICATED', message: 'Oturum geçersiz.' } }, 401),
    });
    const { adapter } = renderApp(<SessionGate>içerik</SessionGate>);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/giris?next=%2F'));
    await expect(adapter.getIdToken()).resolves.toBeNull();
  });
});

describe('Giriş (mock mod)', () => {
  it('giriş sonrası güvenli next yoluna döner; dış adres yok sayılır', async () => {
    mockBackend({
      '/auth/session': () => json(SESSION),
      '/customers/me': () => json(CUSTOMER),
      '/providers/me': FORBIDDEN,
    });
    navigation.search = new URLSearchParams('next=//evil.example');
    renderApp(<LoginScreen />, { signedIn: false });
    await userEvent.click(await screen.findByRole('button', { name: 'Giriş yap' }));
    // Backend hesap oluşturmak için iletişim bilgisi ister: telefonsuz giriş denenmez.
    expect(await screen.findByText(/Geçerli bir cep telefonu girin/)).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('Cep telefonu'), '0532 111 22 33');
    await userEvent.click(screen.getByRole('button', { name: 'Giriş yap' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
  });

  it('yalnızca sağlayıcı profili olan kullanıcı panele gider', async () => {
    mockBackend({
      '/auth/session': () => json(PROVIDER_SESSION),
      '/customers/me': PROFILE_NOT_FOUND,
      '/providers/me': () => json(PROVIDER),
    });
    renderApp(<LoginScreen />, { signedIn: false });
    await userEvent.type(await screen.findByLabelText('Cep telefonu'), '5321112233');
    await userEvent.click(screen.getByRole('button', { name: 'Giriş yap' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/panel'));
  });
});

describe('Rol seçimi', () => {
  it('müşteri profili oluşturur, oturumu yeniler ve ana sayfaya gider', async () => {
    let hasCustomer = false;
    const { calls } = mockBackend({
      '/auth/session': () => json(SESSION),
      'GET /customers/me': () => (hasCustomer ? json(CUSTOMER) : PROFILE_NOT_FOUND()),
      '/providers/me': FORBIDDEN,
      'POST /customers/profile': () => {
        hasCustomer = true;
        return json(CUSTOMER, 201);
      },
    });
    navigation.pathname = '/rol-sec';
    renderApp(<RoleSelectPage />);

    const continueButton = await screen.findByRole('button', { name: 'Devam et →' });
    expect(continueButton).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/Hizmet almak istiyorum/));
    await userEvent.type(screen.getByLabelText('Adınız'), '  Ayşe Nur ');
    await userEvent.click(continueButton);

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
    expect(calls.find((c) => c.path === '/customers/profile')?.body).toEqual({
      displayName: 'Ayşe Nur',
    });
  });

  it('istemci doğrulaması: çok kısa ad backend’e gönderilmez', async () => {
    const { calls } = mockBackend({
      '/auth/session': () => json(SESSION),
      '/customers/me': PROFILE_NOT_FOUND,
      '/providers/me': FORBIDDEN,
    });
    navigation.pathname = '/rol-sec';
    renderApp(<RoleSelectPage />);
    await userEvent.click(await screen.findByLabelText(/Emeğimi sunmak istiyorum/));
    await userEvent.type(screen.getByLabelText('Görünen adınız'), 'A');
    await userEvent.click(screen.getByRole('button', { name: 'Devam et →' }));
    expect(await screen.findByText('Adınız 2–120 karakter olmalı.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/providers/profile')).toBe(false);
  });

  it('sağlayıcı profili isteğe bağlı alanlarla oluşturulur; backend alan hatası (İngilizce metni gösterilmeden) alana bağlanır', async () => {
    const { calls } = mockBackend({
      '/auth/session': () => json(SESSION),
      '/customers/me': () => json(CUSTOMER),
      'GET /providers/me': FORBIDDEN,
      'POST /providers/profile': () =>
        json(
          {
            error: {
              code: 'VALIDATION_FAILED',
              message: 'İstek doğrulanamadı.',
              details: { fields: ['displayName must be shorter than or equal to 120 characters'] },
            },
          },
          400,
        ),
    });
    navigation.pathname = '/rol-sec';
    renderApp(<RoleSelectPage />);

    // Müşteri profili zaten var → yalnızca sağlayıcı seçeneği sunulur.
    await screen.findByLabelText(/Emeğimi sunmak istiyorum/);
    expect(screen.queryByLabelText(/Hizmet almak istiyorum/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByLabelText(/Emeğimi sunmak istiyorum/));
    await userEvent.type(screen.getByLabelText('Görünen adınız'), 'Hatice Y.');
    await userEvent.type(screen.getByLabelText('Deneyim (yıl, isteğe bağlı)'), '4.5');
    await userEvent.click(screen.getByRole('button', { name: 'Devam et →' }));

    expect(await screen.findByLabelText('Görünen adınız')).toHaveAccessibleDescription(
      'Bu ad kabul edilmedi; 2–120 karakter olmalı.',
    );
    expect(calls.find((c) => c.path === '/providers/profile')?.body).toEqual({
      displayName: 'Hatice Y.',
      experienceYears: 4.5,
    });
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe('İkinci profil ekleme', () => {
  it('müşteri sağlayıcı profili ekleyince panele gider (oturum yenilemesiyle yarışmaz)', async () => {
    let isProvider = false;
    mockBackend({
      '/auth/session': () => json(isProvider ? PROVIDER_SESSION : SESSION),
      '/customers/me': () => json(CUSTOMER),
      'GET /providers/me': () => (isProvider ? json(PROVIDER) : FORBIDDEN()),
      'POST /providers/profile': () => {
        isProvider = true;
        return json(PROVIDER, 201);
      },
    });
    navigation.pathname = '/rol-sec';
    renderApp(<RoleSelectPage />);

    await userEvent.click(await screen.findByLabelText(/Emeğimi sunmak istiyorum/));
    await userEvent.type(screen.getByLabelText('Görünen adınız'), 'Ayşe T.');
    await userEvent.click(screen.getByRole('button', { name: 'Devam et →' }));

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/panel'));
    expect(router.replace).not.toHaveBeenCalledWith('/');
  });

  it('iki profili de olan kullanıcı rol ekranından ana sayfaya gönderilir', async () => {
    mockBackend({
      '/auth/session': () => json(PROVIDER_SESSION),
      '/customers/me': () => json(CUSTOMER),
      '/providers/me': () => json(PROVIDER),
    });
    navigation.pathname = '/rol-sec';
    renderApp(<RoleSelectPage />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
  });
});

describe('Sağlayıcı paneli', () => {
  it('başvuru durumunu ve sıradaki adımı gösterir', async () => {
    mockBackend({
      '/auth/session': () => json(PROVIDER_SESSION),
      '/customers/me': PROFILE_NOT_FOUND,
      '/providers/me': () => json({ ...PROVIDER, state: 'PENDING_REVIEW' }),
    });
    navigation.pathname = '/panel';
    renderApp(
      <SessionGate>
        <ProviderHome />
      </SessionGate>,
    );
    expect(await screen.findByText('İncelemede')).toBeInTheDocument();
    expect(screen.getByText(/ekibimiz tarafından inceleniyor/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Atölyem/ })).toHaveAttribute('aria-current', 'page');
  });
});
