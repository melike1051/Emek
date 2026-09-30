import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, vi } from 'vitest';
import { AvailabilityScreen } from '@/app/(app)/panel/musaitlik/AvailabilityScreen';
import { ServiceAreasScreen } from '@/app/(app)/panel/bolgeler/ServiceAreasScreen';
import { ServicesScreen } from '@/app/(app)/panel/hizmetler/ServicesScreen';
import { ProviderHome } from '@/app/(app)/panel/ProviderHome';
import { ProviderProfileScreen } from '@/app/(app)/panel/profil/ProviderProfileScreen';
import { ProviderBookingDetail } from '@/app/(app)/panel/randevular/[id]/ProviderBookingDetail';
import { ProviderBookingsList } from '@/app/(app)/panel/randevular/ProviderBookingsList';
import { SessionGate } from '@/components/SessionGate';
import {
  PROVIDER,
  PROVIDER_SESSION,
  json,
  mockBackend,
  navigation,
  renderApp,
  router,
} from './harness';

vi.mock('next/navigation', () => import('./navigation-mock').then((m) => m.nextNavigationMock));

beforeEach(() => {
  router.replace.mockReset();
  router.push.mockReset();
  navigation.pathname = '/panel';
  navigation.search = new URLSearchParams();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Yalnızca sağlayıcı profili olan kullanıcı (u-1). */
const ONLY_PROVIDER_SESSION = { ...PROVIDER_SESSION, roles: ['PROVIDER'] };
const SERVICE = {
  id: 's-1',
  slug: 'ev-temizligi',
  name: 'Ev temizliği',
  description: null,
  categoryId: 'c-1',
  categorySlug: 'temizlik',
  defaultDurationMinutes: 180,
  pricingModel: 'FIXED',
};
const SERVICE_2 = { ...SERVICE, id: 's-2', slug: 'utu', name: 'Ütü' };
const CATEGORY = { id: 'c-1', slug: 'temizlik', name: 'Temizlik', description: null };
const AREA = {
  id: 'ar-1',
  name: 'Kadıköy',
  latitude: 40.99,
  longitude: 29.03,
  radiusMeters: 5000,
  active: true,
};
const BOOKING = {
  id: 'b-1',
  customerId: 'c-9',
  providerId: 'u-1',
  serviceId: 's-1',
  addressId: 'a-1',
  scheduledStart: '2026-10-12T07:00:00.000Z',
  scheduledEnd: '2026-10-12T10:00:00.000Z',
  priceMinor: '150000',
  currency: 'TRY',
  status: 'PROVIDER_PENDING',
};

function providerBackend(routes: Parameters<typeof mockBackend>[0] = {}) {
  return mockBackend({
    '/auth/session': () => json(ONLY_PROVIDER_SESSION),
    '/customers/me': () =>
      json({ error: { code: 'PROFILE_NOT_FOUND', message: 'Profil bulunamadı.' } }, 404),
    '/providers/me': () => json(PROVIDER),
    '/service-categories': () => json([CATEGORY]),
    '/services': () => json([SERVICE, SERVICE_2]),
    '/skills': () => json([{ id: 'sk-1', slug: 'derin-temizlik', name: 'Derin temizlik' }]),
    'GET /providers/me/services': () => json([]),
    'GET /providers/me/skills': () => json([]),
    'GET /providers/me/service-areas': () => json([]),
    'GET /providers/me/availability': () => json([]),
    '/verification/status': () =>
      json({
        level: 'NONE',
        identityVerified: false,
        assuranceLevel: null,
        verifiedAt: null,
        provider: null,
      }),
    '/addresses': () => json([]),
    '/bookings': () => json([]),
    ...routes,
  });
}

function renderScreen(ui: ReactNode) {
  return renderApp(<SessionGate>{ui}</SessionGate>);
}

describe('Sağlayıcı paneli — hazırlık', () => {
  it('eksikleri listeler; tamamlanmadan başvuru gönderilemez, kimlik uyarısı gösterilir', async () => {
    providerBackend();
    renderScreen(<ProviderHome />);
    const list = await screen.findByRole('list', { name: 'Hazırlık' });
    expect(within(list).getByRole('link', { name: 'Sunduğunuz hizmetleri seçin' })).toHaveAttribute(
      'href',
      '/panel/hizmetler',
    );
    expect(within(list).getAllByText('Eksik')).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Başvuruyu incelemeye gönder' })).toBeDisabled();
    expect(await screen.findByText(/Kimliği doğrulanmamış sağlayıcılar/)).toBeInTheDocument();
  });

  it('hazır profil başvuruyu gönderir ve oturumu yeniler; yanıt bekleyen randevu listelenir', async () => {
    let state = 'DRAFT';
    const { calls } = providerBackend({
      '/providers/me': () => json({ ...PROVIDER, bio: 'Titizim.', state }),
      'GET /providers/me/services': () =>
        json([{ serviceId: 's-1', slug: 'ev-temizligi', name: 'Ev temizliği', active: true }]),
      'GET /providers/me/service-areas': () => json([AREA]),
      'GET /providers/me/availability': () =>
        json([{ id: 'w-1', startsAt: BOOKING.scheduledStart, endsAt: BOOKING.scheduledEnd }]),
      'POST /providers/me/submit': () => {
        state = 'PENDING_REVIEW';
        return json({ ...PROVIDER, state });
      },
      '/bookings': () => json([BOOKING, { ...BOOKING, id: 'b-2', providerId: 'someone-else' }]),
    });
    renderScreen(<ProviderHome />);
    const submit = await screen.findByRole('button', { name: 'Başvuruyu incelemeye gönder' });
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    expect(await screen.findByText('İncelemede')).toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/providers/me/submit')).toHaveLength(1);
    // Başvuru gönderildikten sonra buton kalkar.
    expect(screen.queryByRole('button', { name: /Başvuru/ })).not.toBeInTheDocument();

    const pending = screen.getByText('Yanıtınız bekleniyor');
    expect(pending.closest('li')?.querySelector('a')).toHaveAttribute(
      'href',
      '/panel/randevular/b-1',
    );
    expect(screen.getAllByText('Yanıtınız bekleniyor')).toHaveLength(1); // başkasının randevusu yok
  });
});

describe('Profil', () => {
  it('düzenlenen alanları gönderir; deneyim virgülle girilebilir', async () => {
    const { calls } = providerBackend({
      'PATCH /providers/me': (_m, body) => json({ ...PROVIDER, ...(body as object) }),
    });
    navigation.pathname = '/panel/profil';
    renderScreen(<ProviderProfileScreen />);
    const bio = await screen.findByLabelText('Kendinizi tanıtın');
    await userEvent.type(bio, 'On yıldır ev temizliği yapıyorum.');
    const experience = screen.getByLabelText('Deneyim (yıl)');
    await userEvent.clear(experience);
    await userEvent.type(experience, '4,5');
    await userEvent.selectOptions(screen.getByLabelText('Günde en fazla randevu'), '2');
    await userEvent.click(screen.getByRole('button', { name: 'Kaydet' }));
    expect(await screen.findByText('Profiliniz kaydedildi.')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      displayName: 'Hatice Yılmaz',
      bio: 'On yıldır ev temizliği yapıyorum.',
      experienceYears: 4.5,
      maxDailyBookings: 2,
    });
  });

  it('geçersiz deneyim gönderilmez', async () => {
    const { calls } = providerBackend();
    navigation.pathname = '/panel/profil';
    renderScreen(<ProviderProfileScreen />);
    const experience = await screen.findByLabelText('Deneyim (yıl)');
    await userEvent.clear(experience);
    await userEvent.type(experience, '95');
    await userEvent.click(screen.getByRole('button', { name: 'Kaydet' }));
    expect(screen.getByText('Deneyim 0–80 yıl arasında olmalı.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
});

describe('Hizmetler ve beceriler', () => {
  it('hizmet seçimi ekler/kaldırır; beceri seviyeyle eklenir ve doğrulama durumu gösterilir', async () => {
    let offered: { serviceId: string; slug: string; name: string; active: boolean }[] = [];
    let skills: object[] = [];
    const { calls } = providerBackend({
      'GET /providers/me/services': () => json(offered),
      'POST /providers/me/services': (_m, body) => {
        offered = [
          {
            serviceId: (body as { serviceId: string }).serviceId,
            slug: 'x',
            name: 'x',
            active: true,
          },
        ];
        return json(offered, 201);
      },
      'GET /providers/me/skills': () => json(skills),
      'POST /providers/me/skills': () => {
        skills = [
          {
            skillId: 'sk-1',
            slug: 'derin-temizlik',
            name: 'Derin temizlik',
            level: 'EXPERT',
            verified: false,
          },
        ];
        return json(skills, 201);
      },
    });
    navigation.pathname = '/panel/hizmetler';
    renderScreen(<ServicesScreen />);
    const chip = await screen.findByRole('button', { name: 'Ev temizliği' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(chip);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Ev temizliği' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    expect(
      calls.find((c) => c.method === 'POST' && c.path === '/providers/me/services')?.body,
    ).toEqual({
      serviceId: 's-1',
    });

    await userEvent.selectOptions(screen.getByLabelText('Beceri'), 'sk-1');
    await userEvent.selectOptions(screen.getByLabelText('Seviye'), 'EXPERT');
    await userEvent.click(screen.getByRole('button', { name: 'Beceri ekle' }));
    expect(await screen.findByText('Doğrulama bekliyor')).toBeInTheDocument();
    expect(
      calls.find((c) => c.path === '/providers/me/skills' && c.method === 'POST')?.body,
    ).toEqual({
      skillId: 'sk-1',
      level: 'EXPERT',
    });
  });
});

describe('Hizmet bölgeleri', () => {
  it('kayıtlı adresten merkez alır, yarıçapı metreye çevirir, koordinatı 6 ondalığa yuvarlar', async () => {
    const { calls } = providerBackend({
      '/addresses': () =>
        json([
          {
            id: 'a-1',
            label: 'Ev',
            city: 'İstanbul',
            district: 'Moda',
            line: 'x',
            latitude: 40.98123456,
            longitude: 29.02654321,
          },
        ]),
      'POST /providers/me/service-areas': (_m, body) => json({ ...AREA, ...(body as object) }, 201),
    });
    navigation.pathname = '/panel/bolgeler';
    renderScreen(<ServiceAreasScreen />);
    expect(await screen.findByText('Henüz hizmet bölgeniz yok')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bölgeyi ekle' })).toBeDisabled();
    await userEvent.selectOptions(await screen.findByLabelText('Kayıtlı adresten seç'), 'a-1');
    await userEvent.selectOptions(screen.getByLabelText('Ne kadar uzağa gidebilirsiniz?'), '10');
    await userEvent.click(screen.getByRole('button', { name: 'Bölgeyi ekle' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.path === '/providers/me/service-areas')?.body,
      ).toEqual({
        name: 'Moda',
        latitude: 40.981235,
        longitude: 29.026543,
        radiusMeters: 10000,
      }),
    );
  });

  it('bölge silme iki adımlıdır; 5 bölgede ekleme formu gizlenir', async () => {
    const areas = Array.from({ length: 5 }, (_, index) => ({
      ...AREA,
      id: `ar-${index}`,
      name: `Bölge ${index}`,
    }));
    const { calls } = providerBackend({
      'GET /providers/me/service-areas': () => json(areas),
      'DELETE /providers/me/service-areas/ar-0': () => new Response(null, { status: 204 }),
    });
    navigation.pathname = '/panel/bolgeler';
    renderScreen(<ServiceAreasScreen />);
    expect(await screen.findByText('En fazla 5 bölge ekleyebilirsiniz.')).toBeInTheDocument();
    const first = screen.getByText('Bölge 0').closest('article')!;
    await userEvent.click(within(first).getByRole('button', { name: 'Bölgeyi kaldır' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await userEvent.click(within(first).getByRole('button', { name: 'Evet, kaldır' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
  });
});

describe('Müsaitlik', () => {
  it('İstanbul saatiyle girilen aralığı UTC ISO olarak gönderir; çakışma mesajını gösterir', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-07T06:00:00.000Z') }); // Çarşamba 09:00
    let conflict = false;
    const { calls } = providerBackend({
      'POST /providers/me/availability': (_m, body) => {
        if (conflict) {
          return json(
            {
              error: {
                code: 'BOOKING_CONFLICT',
                message: 'Bu zaman aralığı mevcut bir müsaitlik penceresiyle çakışıyor.',
              },
            },
            409,
          );
        }
        conflict = true;
        return json({ id: 'w-1', ...(body as object) }, 201);
      },
    });
    navigation.pathname = '/panel/musaitlik';
    renderScreen(<AvailabilityScreen />);

    // Hafta pazartesiden başlar; geçmiş günlere ekleme yapılamaz.
    const monday = await screen.findByRole('heading', {
      name: /5 Ekim Pazartesi|Pazartesi, 5 Ekim|5 Ekim/,
    });
    expect(
      within(monday.closest('article')!).queryByRole('button', { name: 'Saat ekle' }),
    ).toBeNull();

    const friday = screen.getByRole('heading', { name: /9 Ekim/ }).closest('article')!;
    await userEvent.click(within(friday).getByRole('button', { name: 'Saat ekle' }));
    await userEvent.click(within(friday).getByRole('button', { name: 'Ekle' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.path === '/providers/me/availability')?.body,
      ).toEqual({
        startsAt: '2026-10-09T06:00:00.000Z',
        endsAt: '2026-10-09T14:00:00.000Z',
      }),
    );
    expect(
      calls.find((c) => c.method === 'GET' && c.path === '/providers/me/availability'),
    ).toBeDefined();

    await userEvent.click(within(friday).getByRole('button', { name: 'Saat ekle' }));
    await userEvent.click(within(friday).getByRole('button', { name: 'Ekle' }));
    expect(
      await within(friday).findByText(
        'Bu zaman aralığı mevcut bir müsaitlik penceresiyle çakışıyor.',
      ),
    ).toBeInTheDocument();
  });
});

describe('Sağlayıcı randevuları', () => {
  it('liste yalnızca sağlayıcısı olunan randevuları sağlayıcı diliyle gösterir', async () => {
    providerBackend({
      '/bookings': () =>
        json([BOOKING, { ...BOOKING, id: 'b-9', providerId: 'x', customerId: 'u-1' }]),
    });
    navigation.pathname = '/panel/randevular';
    renderScreen(<ProviderBookingsList />);
    expect(await screen.findByText('Yanıtınız bekleniyor')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Ev temizliği/ })).toHaveLength(1);
  });

  it('kabul iki adımlıdır ve Idempotency-Key ile /confirm çağırır', async () => {
    let status = 'PROVIDER_PENDING';
    const { calls } = providerBackend({
      'GET /bookings/b-1': () => json({ ...BOOKING, status }),
      'POST /bookings/b-1/confirm': () => {
        status = 'CONFIRMED';
        return json({ ...BOOKING, status });
      },
      '/bookings/b-1/history': () => json([]),
      '/bookings/b-1/disputes': () => json([]),
    });
    navigation.pathname = '/panel/randevular/b-1';
    renderScreen(<ProviderBookingDetail bookingId="b-1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Randevuyu kabul et' }));
    expect(calls.some((c) => c.path === '/bookings/b-1/confirm')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Evet, kabul ediyorum' }));
    expect(await screen.findByText('Müşteri ödemesi bekleniyor')).toBeInTheDocument();
    const confirm = calls.find((c) => c.path === '/bookings/b-1/confirm');
    expect(confirm?.headers.get('Idempotency-Key')).toBeTruthy();
  });

  it('ret gerekçeli iptaldir', async () => {
    const { calls } = providerBackend({
      'GET /bookings/b-1': () => json(BOOKING),
      'POST /bookings/b-1/cancel': () => json({ ...BOOKING, status: 'CANCELLED' }),
      '/bookings/b-1/history': () => json([]),
      '/bookings/b-1/disputes': () => json([]),
    });
    navigation.pathname = '/panel/randevular/b-1';
    renderScreen(<ProviderBookingDetail bookingId="b-1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Reddet' }));
    await userEvent.type(screen.getByLabelText('Gerekçe (isteğe bağlı)'), 'O gün doluyum');
    await userEvent.click(screen.getByRole('button', { name: 'Randevuyu reddet' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/bookings/b-1/cancel')?.body).toEqual({
        reason: 'O gün doluyum',
      }),
    );
  });

  it('hizmet günü adımları sırayla ilerler; her adım kendi anahtarını taşır', async () => {
    const order = ['SCHEDULED', 'PROVIDER_ARRIVING', 'CHECKED_IN'];
    let index = 0;
    const { calls } = providerBackend({
      'GET /bookings/b-1': () => json({ ...BOOKING, status: order[index] }),
      'POST /bookings/b-1/transitions': () => {
        index += 1;
        return json({ ...BOOKING, status: order[index] });
      },
      '/bookings/b-1/history': () => json([]),
      '/bookings/b-1/disputes': () => json([]),
      '/bookings/b-1/documents': () => json([]),
    });
    navigation.pathname = '/panel/randevular/b-1';
    renderScreen(<ProviderBookingDetail bookingId="b-1" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Yola çıktım' }));
    await userEvent.click(screen.getByRole('button', { name: 'Evet, yola çıkıyorum' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Adrese vardım' }));
    await userEvent.click(screen.getByRole('button', { name: 'Evet, adresteyim' }));
    expect(await screen.findByRole('button', { name: 'Hizmeti başlat' })).toBeInTheDocument();

    const sent = calls.filter((c) => c.path === '/bookings/b-1/transitions');
    expect(sent.map((c) => c.body)).toEqual([{ to: 'PROVIDER_ARRIVING' }, { to: 'CHECKED_IN' }]);
    const keys = sent.map((c) => c.headers.get('Idempotency-Key'));
    expect(new Set(keys).size).toBe(2);
    // Adrese varınca "önce" fotoğrafı eklenebilir.
    expect(screen.getByRole('form', { name: 'Kanıt ekle' })).toBeInTheDocument();
    expect(screen.getByText('Tür: Önce')).toBeInTheDocument();
  });

  it('başka sağlayıcının randevusu yönetilmez', async () => {
    providerBackend({ 'GET /bookings/b-1': () => json({ ...BOOKING, providerId: 'other' }) });
    navigation.pathname = '/panel/randevular/b-1';
    renderScreen(<ProviderBookingDetail bookingId="b-1" />);
    expect(await screen.findByText('Bu randevuyu siz vermiyorsunuz')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Randevuyu kabul et' })).toBeNull();
  });
});

describe('Kanıt yükleme', () => {
  const PHOTO = new File(['önce-fotoğrafı'], 'once.jpg', { type: 'image/jpeg', lastModified: 1 });
  const UPLOAD_URL = '/api/v1/_dev/storage/bucket/doc-key?method=PUT&expires=1&signature=s';

  function evidenceBackend(put: () => Response) {
    let registrations = 0;
    let documents: object[] = [];
    const backend = providerBackend({
      'GET /bookings/b-1': () => json({ ...BOOKING, status: 'IN_PROGRESS' }),
      '/bookings/b-1/history': () => json([]),
      '/bookings/b-1/disputes': () => json([]),
      '/bookings/b-1/documents': () => json(documents),
      'POST /documents': () => {
        registrations += 1;
        return json(
          {
            document: { id: `d-${registrations}`, status: 'PENDING' },
            uploadUrl: UPLOAD_URL,
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
          201,
        );
      },
      'PUT /_dev/storage/bucket/doc-key': put,
      'POST /documents/d-1/confirm': () => {
        const doc = {
          id: 'd-1',
          bookingId: 'b-1',
          documentType: 'BEFORE_PHOTO',
          contentType: 'image/jpeg',
          sizeBytes: '10',
          sha256: 'ab'.repeat(32),
          status: 'AVAILABLE',
          uploadedAt: '2026-10-12T07:30:00.000Z',
          createdAt: '2026-10-12T07:30:00.000Z',
        };
        documents = [doc];
        return json(doc, 201);
      },
    });
    return { ...backend, registrations: () => registrations };
  }

  it('kayıt → imzalı PUT (kimlik başlığı yok) → özetle onay; liste yenilenir', async () => {
    const { calls } = evidenceBackend(() => new Response(null, { status: 200 }));
    navigation.pathname = '/panel/randevular/b-1';
    renderScreen(<ProviderBookingDetail bookingId="b-1" />);
    const form = await screen.findByRole('form', { name: 'Kanıt ekle' });
    await userEvent.upload(within(form).getByLabelText('Dosya'), PHOTO);
    await userEvent.click(within(form).getByRole('button', { name: 'Yükle' }));
    expect(
      await screen.findByText('Fotoğraf eklendi ve bütünlük özeti kaydedildi.'),
    ).toBeInTheDocument();
    expect(await screen.findByText('ab'.repeat(32))).toBeInTheDocument();

    const register = calls.find((c) => c.method === 'POST' && c.path === '/documents');
    expect(register?.body).toEqual({
      bookingId: 'b-1',
      documentType: 'BEFORE_PHOTO',
      contentType: 'image/jpeg',
    });
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.headers.get('Content-Type')).toBe('image/jpeg');
    expect(put?.headers.has('Authorization')).toBe(false);
    const confirm = calls.find((c) => c.path === '/documents/d-1/confirm');
    expect((confirm?.body as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ağ hatasında yeniden deneme aynı kaydı kullanır (sahipsiz kayıt bırakmaz)', async () => {
    let fail = true;
    const backend = evidenceBackend(() => {
      if (fail) {
        fail = false;
        throw new TypeError('network');
      }
      return new Response(null, { status: 200 });
    });
    navigation.pathname = '/panel/randevular/b-1';
    renderScreen(<ProviderBookingDetail bookingId="b-1" />);
    const form = await screen.findByRole('form', { name: 'Kanıt ekle' });
    await userEvent.upload(within(form).getByLabelText('Dosya'), PHOTO);
    await userEvent.click(within(form).getByRole('button', { name: 'Yükle' }));
    const retry = await within(form).findByRole('button', { name: 'Tekrar dene' });
    await userEvent.click(retry);
    expect(
      await screen.findByText('Fotoğraf eklendi ve bütünlük özeti kaydedildi.'),
    ).toBeInTheDocument();
    expect(backend.registrations()).toBe(1);
  });

  it('desteklenmeyen dosya türü gönderilmez', async () => {
    const { calls } = evidenceBackend(() => new Response(null, { status: 200 }));
    navigation.pathname = '/panel/randevular/b-1';
    renderScreen(<ProviderBookingDetail bookingId="b-1" />);
    const form = await screen.findByRole('form', { name: 'Kanıt ekle' });
    await userEvent.upload(
      within(form).getByLabelText('Dosya'),
      new File(['x'], 'not.gif', { type: 'image/gif' }),
      { applyAccept: false },
    );
    expect(within(form).getByRole('alert')).toHaveTextContent('Yalnızca JPEG, PNG, WebP');
    expect(within(form).getByRole('button', { name: 'Yükle' })).toBeDisabled();
    expect(calls.some((c) => c.path === '/documents')).toBe(false);
  });
});
