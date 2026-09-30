import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, vi } from 'vitest';
import { ExploreHome } from '@/app/(app)/ExploreHome';
import { BookingsList } from '@/app/(app)/randevular/BookingsList';
import { BookingDetail } from '@/app/(app)/randevular/[id]/BookingDetail';
import { SafetyScreen } from '@/app/(app)/randevular/[id]/guvenlik/SafetyScreen';
import { ProofScreen } from '@/app/(app)/randevular/[id]/kanit/ProofScreen';
import { MatchResultScreen } from '@/app/(app)/talep/[id]/eslesme/MatchResultScreen';
import { RequestReview } from '@/app/(app)/talep/[id]/RequestReview';
import { SessionGate } from '@/components/SessionGate';
import {
  CUSTOMER,
  FORBIDDEN,
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
  router.push.mockReset();
  navigation.pathname = '/';
  navigation.search = new URLSearchParams();
});
afterEach(() => vi.unstubAllGlobals());

const ADDRESS = {
  id: 'a-1',
  label: 'Ev',
  city: 'İstanbul',
  district: 'Kadıköy',
  line: 'Moda Cd. 1',
  latitude: 40.98,
  longitude: 29.02,
};
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
const CATEGORY = { id: 'c-1', slug: 'temizlik', name: 'Temizlik', description: null };
const REQUEST = {
  id: 'r-1',
  serviceId: 's-1',
  addressId: 'a-1',
  preferredStart: '2026-10-12T07:00:00.000Z',
  preferredEnd: '2026-10-12T11:00:00.000Z',
  durationMinutes: 180,
  status: 'OPEN',
  parserVersion: 'nlp-1.2.0',
  parserConfidence: 0.92,
};
const BOOKING = {
  id: 'b-1',
  customerId: 'u-1',
  providerId: 'p-9',
  serviceId: 's-1',
  addressId: 'a-1',
  scheduledStart: '2026-10-12T07:00:00.000Z',
  scheduledEnd: '2026-10-12T10:00:00.000Z',
  priceMinor: '150000',
  currency: 'TRY',
  status: 'CONFIRMED',
};

/** Müşteri oturumu + katalog: her ekran testi bunun üstüne kendi uçlarını ekler. */
function customerBackend(routes: Parameters<typeof mockBackend>[0] = {}) {
  return mockBackend({
    '/auth/session': () => json(SESSION),
    '/customers/me': () => json(CUSTOMER),
    '/providers/me': FORBIDDEN,
    '/service-categories': () => json([CATEGORY]),
    '/services': () => json([SERVICE]),
    '/addresses': () => json([ADDRESS]),
    ...routes,
  });
}

function renderScreen(ui: ReactNode) {
  return renderApp(<SessionGate>{ui}</SessionGate>);
}

const apiError = (status: number, code: string, message: string, requestId?: string) =>
  json({ error: { code, message, ...(requestId ? { requestId } : {}) } }, status);

describe('Keşfet & Talep', () => {
  it('doğal dil talebi oluşunca talep özetine gider', async () => {
    const { calls } = customerBackend({
      'POST /booking-requests/from-text': () =>
        json(
          {
            status: 'CREATED',
            request: REQUEST,
            parserVersion: 'nlp-1.2.0',
            confidence: 0.92,
            clarifications: [],
          },
          201,
        ),
    });
    renderScreen(<ExploreHome />);
    await userEvent.type(
      await screen.findByLabelText('Neye ihtiyacınız var?'),
      'Cumartesi 3 saat ev temizliği',
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Uygun sağlayıcıyı bul' })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Uygun sağlayıcıyı bul' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/talep/r-1'));
    const sent = calls.find((c) => c.path === '/booking-requests/from-text');
    expect(sent?.body).toEqual({ rawText: 'Cumartesi 3 saat ev temizliği', addressId: 'a-1' });
  });

  it('netleştirme sorularını gösterir; seçenek metne eklenir', async () => {
    customerBackend({
      'POST /booking-requests/from-text': () =>
        json(
          {
            status: 'NEEDS_CLARIFICATION',
            request: null,
            parserVersion: 'nlp-1.2.0',
            confidence: 0.4,
            clarifications: [{ field: 'date', question: 'Hangi gün?', options: ['Cumartesi'] }],
          },
          201,
        ),
    });
    renderScreen(<ExploreHome />);
    const input = await screen.findByLabelText('Neye ihtiyacınız var?');
    await userEvent.type(input, 'temizlik');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Uygun sağlayıcıyı bul' })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Uygun sağlayıcıyı bul' }));
    expect(await screen.findByText('Hangi gün?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cumartesi' }));
    expect(input).toHaveValue('temizlik Cumartesi');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('AI erişilemezse (FORM_REQUIRED) formu açar ve formla talep oluşturur', async () => {
    const { calls } = customerBackend({
      'POST /booking-requests/from-text': () =>
        json(
          {
            status: 'FORM_REQUIRED',
            request: null,
            parserVersion: null,
            confidence: null,
            clarifications: [],
          },
          201,
        ),
      'POST /booking-requests': () => json({ ...REQUEST, id: 'r-2', parserVersion: null }, 201),
    });
    renderScreen(<ExploreHome />);
    await userEvent.type(await screen.findByLabelText('Neye ihtiyacınız var?'), 'x');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Uygun sağlayıcıyı bul' })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Uygun sağlayıcıyı bul' }));
    expect(await screen.findByText(/Akıllı talep şu an kullanılamıyor/)).toBeInTheDocument();

    const form = screen.getByRole('form', { name: 'Talep formu' });
    await userEvent.selectOptions(within(form).getByLabelText('Hizmet'), 's-1');
    expect(within(form).getByLabelText('Süre (dakika)')).toHaveValue(180);
    await userEvent.type(within(form).getByLabelText('Tarih'), '2099-10-12');
    await userEvent.click(within(form).getByRole('button', { name: 'Talebi oluştur' }));

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/talep/r-2'));
    expect(calls.find((c) => c.method === 'POST' && c.path === '/booking-requests')?.body).toEqual({
      serviceId: 's-1',
      addressId: 'a-1',
      preferredStart: '2099-10-12T06:00:00.000Z',
      preferredEnd: '2099-10-12T14:00:00.000Z',
      durationMinutes: 180,
    });
  });
});

describe('Talep özeti ve eşleştirme', () => {
  it('eşleştirir, Idempotency-Key gönderir ve sonuca gider', async () => {
    const { calls } = customerBackend({
      '/booking-requests/r-1': () => json(REQUEST),
      'POST /booking-requests/r-1/match': () =>
        json({ requestId: 'r-1', status: 'MATCHED', bookingId: 'b-1' }, 201),
    });
    renderScreen(<RequestReview requestId="r-1" />);
    expect(await screen.findByText('Ev temizliği')).toBeInTheDocument();
    expect(screen.queryByText(/emin değiliz/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sağlayıcı bul' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/talep/r-1/eslesme'));
    const match = calls.find((c) => c.method === 'POST' && c.path.endsWith('/match'));
    expect(match?.headers.get('Idempotency-Key')).toMatch(/[0-9a-f-]{36}/);
  });

  it('düşük güvende kontrol uyarısı gösterir', async () => {
    customerBackend({
      '/booking-requests/r-1': () => json({ ...REQUEST, parserConfidence: 0.65 }),
    });
    renderScreen(<RequestReview requestId="r-1" />);
    expect(await screen.findByText(/emin değiliz/)).toBeInTheDocument();
  });

  it('başarısız eşleştirmenin tekrarı aynı Idempotency-Key ile gider', async () => {
    let attempt = 0;
    const { calls } = customerBackend({
      '/booking-requests/r-1': () => json(REQUEST),
      'POST /booking-requests/r-1/match': () =>
        ++attempt === 1
          ? apiError(409, 'MATCHING_NO_CANDIDATE', 'Uygun sağlayıcı bulunamadı.', 'req-7')
          : json({ requestId: 'r-1', status: 'MATCHED', bookingId: 'b-1' }, 201),
    });
    renderScreen(<RequestReview requestId="r-1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sağlayıcı bul' }));
    expect(await screen.findByText('Uygun sağlayıcı bulunamadı.')).toBeInTheDocument();
    expect(screen.getByText('Referans: req-7')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sağlayıcı bul' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/talep/r-1/eslesme'));
    const keys = calls
      .filter((c) => c.path.endsWith('/match'))
      .map((c) => c.headers.get('Idempotency-Key'));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('talep zaten eşleştirilmişse hata yerine sonuca gider', async () => {
    customerBackend({
      '/booking-requests/r-1': () => json(REQUEST),
      'POST /booking-requests/r-1/match': () =>
        apiError(409, 'MATCHING_ALREADY_COMPLETED', 'Talep zaten eşleştirildi.'),
    });
    renderScreen(<RequestReview requestId="r-1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sağlayıcı bul' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/talep/r-1/eslesme'));
    expect(screen.queryByText('Talep zaten eşleştirildi.')).not.toBeInTheDocument();
  });
});

describe('Eşleşme sonucu', () => {
  it('seçilen sağlayıcıyı ve Türkçe gerekçeleri gösterir; bilinmeyen kodu göstermez', async () => {
    customerBackend({
      '/booking-requests/r-1/match': () =>
        json({
          requestId: 'r-1',
          runId: 'run-1',
          status: 'MATCHED',
          degraded: false,
          bookingId: 'b-1',
          providerId: 'p-9',
          providerName: 'Hatice Yılmaz',
          scheduledStart: BOOKING.scheduledStart,
          scheduledEnd: BOOKING.scheduledEnd,
          explanation: [
            { code: 'NEARBY', value: 2 },
            { code: 'ALL_REQUIRED_SKILLS_VERIFIED', value: null },
            { code: 'FUTURE_CODE', value: 0.77 },
          ],
        }),
    });
    renderScreen(<MatchResultScreen requestId="r-1" />);
    expect(await screen.findByText('Hatice Yılmaz')).toBeInTheDocument();
    expect(screen.getByText('Yaklaşık 2 km uzaklıkta')).toBeInTheDocument();
    expect(screen.getByText('Gerekli tüm becerileri doğrulanmış')).toBeInTheDocument();
    expect(screen.queryByText(/FUTURE_CODE|0\.77/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Randevuya git' }));
    expect(router.push).toHaveBeenCalledWith('/randevular/b-1');
  });

  it('aday yoksa boş durum ve yeni talep yolu gösterir', async () => {
    customerBackend({
      '/booking-requests/r-1/match': () =>
        json({
          requestId: 'r-1',
          runId: 'run-1',
          status: 'NO_CANDIDATE',
          degraded: false,
          bookingId: null,
          providerId: null,
          providerName: null,
          scheduledStart: null,
          scheduledEnd: null,
          explanation: [],
        }),
    });
    renderScreen(<MatchResultScreen requestId="r-1" />);
    expect(await screen.findByText('Şu an uygun sağlayıcı bulamadık')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Yeni talep oluştur' })).toHaveAttribute('href', '/');
  });
});

describe('Randevular', () => {
  it('yalnızca müşteri olarak alınan randevuları aktif/geçmiş ayırır', async () => {
    customerBackend({
      '/bookings': () =>
        json([
          BOOKING,
          { ...BOOKING, id: 'b-2', status: 'SETTLED' },
          // Aynı hesabın sağlayıcı olarak verdiği hizmet bu listede görünmez.
          { ...BOOKING, id: 'b-3', customerId: 'someone-else', providerId: 'u-1' },
        ]),
    });
    renderScreen(<BookingsList />);
    expect(await screen.findByText('Onaylandı — ödeme bekleniyor')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Ev temizliği/ })).toHaveLength(1);
    await userEvent.click(screen.getByRole('tab', { name: 'Geçmiş' }));
    expect(await screen.findByText('Kapandı')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Ev temizliği/ })).toHaveLength(1);
  });
});

describe('Randevu detayı', () => {
  it('CONFIRMED: ödemeyi boş gövde + Idempotency-Key ile yetkilendirir', async () => {
    let status = 'CONFIRMED';
    let paid = false;
    const { calls } = customerBackend({
      '/bookings/b-1': () => json({ ...BOOKING, status }),
      '/bookings/b-1/history': () =>
        json([
          {
            fromStatus: null,
            toStatus: 'REQUESTED',
            reason: null,
            createdAt: '2026-10-01T10:00:00Z',
          },
        ]),
      '/bookings/b-1/disputes': () => json([]),
      'GET /bookings/b-1/payment': () =>
        paid
          ? json({
              id: 'pay-1',
              bookingId: 'b-1',
              amountMinor: '150000',
              currency: 'TRY',
              refundedMinor: '0',
              status: 'AUTHORIZED',
              authorizationExpiresAt: null,
              releasedAt: null,
            })
          : apiError(404, 'NOT_FOUND', 'Kayıt bulunamadı.'),
      'POST /bookings/b-1/payment': () => {
        paid = true;
        status = 'SCHEDULED';
        return json(
          {
            paymentId: 'pay-1',
            clientToken: 't',
            amountMinor: '150000',
            currency: 'TRY',
            status: 'AUTHORIZED',
            expiresAt: '2026-10-20T00:00:00Z',
          },
          201,
        );
      },
    });
    renderScreen(<BookingDetail bookingId="b-1" />);
    const pay = await screen.findByRole('button', { name: '1.500,00 ₺ ödemeyi onayla' });
    // Hizmet başlamadan iptal mümkündür.
    expect(screen.getByRole('button', { name: 'Randevuyu iptal et' })).toBeInTheDocument();
    await userEvent.click(pay);

    expect(await screen.findByText('Yetkilendirildi')).toBeInTheDocument();
    expect(await screen.findByText('Planlandı')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /ödemeyi onayla/ })).not.toBeInTheDocument();
    const post = calls.find((c) => c.method === 'POST' && c.path === '/bookings/b-1/payment');
    expect(post?.body).toEqual({});
    expect(post?.headers.get('Idempotency-Key')).toBeTruthy();
  });

  it('CHECKED_OUT: hizmet onayı iki adımlıdır ve CUSTOMER_CONFIRMED geçişi gönderir', async () => {
    const { calls } = customerBackend({
      '/bookings/b-1': () => json({ ...BOOKING, status: 'CHECKED_OUT' }),
      '/bookings/b-1/history': () => json([]),
      '/bookings/b-1/disputes': () => json([]),
      'GET /bookings/b-1/payment': () =>
        json({
          id: 'pay-1',
          bookingId: 'b-1',
          amountMinor: '150000',
          currency: 'TRY',
          refundedMinor: '0',
          status: 'HELD',
          authorizationExpiresAt: null,
          releasedAt: null,
        }),
      // Sunucu onayı aynı transaction'da `COMPLETED`'a zincirler (Faz 17, R-115).
      'POST /bookings/b-1/transitions': () => json({ ...BOOKING, status: 'COMPLETED' }),
    });
    renderScreen(<BookingDetail bookingId="b-1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Hizmeti onayla' }));
    expect(calls.some((c) => c.path === '/bookings/b-1/transitions')).toBe(false);
    // Hizmet başladıktan sonra iptal yolu yoktur; itiraz vardır.
    expect(screen.queryByRole('button', { name: 'Randevuyu iptal et' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sorun bildir / itiraz aç' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Evet, hizmet tamamlandı' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/bookings/b-1/transitions')?.body).toEqual({
        to: 'CUSTOMER_CONFIRMED',
      }),
    );
  });

  it('COMPLETED: değerlendirme gönderir; zaten değerlendirildiyse teşekkür gösterir', async () => {
    const { calls } = customerBackend({
      '/bookings/b-1': () => json({ ...BOOKING, status: 'COMPLETED' }),
      '/bookings/b-1/history': () => json([]),
      '/bookings/b-1/disputes': () => json([]),
      'GET /bookings/b-1/payment': () => apiError(404, 'NOT_FOUND', 'yok'),
      'POST /bookings/b-1/review': () =>
        apiError(409, 'REVIEW_ALREADY_EXISTS', 'Bu rezervasyonu zaten değerlendirdiniz.'),
    });
    renderScreen(<BookingDetail bookingId="b-1" />);
    const send = await screen.findByRole('button', { name: 'Gönder' });
    expect(send).toBeDisabled();
    await userEvent.click(screen.getByRole('radio', { name: '4 yıldız' }));
    await userEvent.click(send);
    expect(await screen.findByText('Değerlendirmeniz için teşekkürler.')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/bookings/b-1/review')?.body).toEqual({ rating: 4 });
  });

  it('itiraz açılır; açık itiraz varken ikinci form gösterilmez', async () => {
    const disputes: unknown[] = [];
    customerBackend({
      '/bookings/b-1': () => json({ ...BOOKING, status: 'COMPLETED' }),
      '/bookings/b-1/history': () => json([]),
      'GET /bookings/b-1/disputes': () => json(disputes),
      'GET /bookings/b-1/payment': () => apiError(404, 'NOT_FOUND', 'yok'),
      'POST /bookings/b-1/disputes': (_m, body) => {
        const created = {
          id: 'd-1',
          bookingId: 'b-1',
          description: null,
          status: 'OPEN',
          resolution: null,
          refundAmountMinor: null,
          createdAt: '2026-10-12T12:00:00Z',
          resolvedAt: null,
          ...(body as object),
        };
        disputes.push(created);
        return json(created, 201);
      },
    });
    renderScreen(<BookingDetail bookingId="b-1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sorun bildir / itiraz aç' }));
    await userEvent.selectOptions(screen.getByLabelText('Konu'), 'DAMAGE');
    await userEvent.type(screen.getByLabelText('Ne oldu?'), 'Vazo kırıldı');
    await userEvent.click(screen.getByRole('button', { name: 'İtirazı gönder' }));
    expect(await screen.findByText('Hasar')).toBeInTheDocument();
    expect(screen.getByText('Açık')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Sorun bildir / itiraz aç' }),
    ).not.toBeInTheDocument();
  });

  it('iptal iki adımlıdır ve gerekçeyi gönderir', async () => {
    let status = 'PROVIDER_PENDING';
    const { calls } = customerBackend({
      '/bookings/b-1': () => json({ ...BOOKING, status }),
      '/bookings/b-1/history': () => json([]),
      '/bookings/b-1/disputes': () => json([]),
      'POST /bookings/b-1/cancel': () => {
        status = 'CANCELLED';
        return json({ ...BOOKING, status });
      },
    });
    renderScreen(<BookingDetail bookingId="b-1" />);
    expect(await screen.findByText(/Sağlayıcı randevuyu onayladığında/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Randevuyu iptal et' }));
    await userEvent.type(screen.getByLabelText('İptal gerekçesi (isteğe bağlı)'), 'Plan değişti');
    await userEvent.click(screen.getByRole('button', { name: 'İptal et' }));
    expect(await screen.findByText('İptal edildi')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/bookings/b-1/cancel')?.body).toEqual({
      reason: 'Plan değişti',
    });
  });
});

describe('Güvenlik & oturum', () => {
  const SESSION_VIEW = {
    sessionId: 'ss-1',
    bookingId: 'b-1',
    status: 'ACTIVE',
    acceptsTelemetry: true,
    telemetryExpectedFromYou: false,
    telemetryIntervalSeconds: 60,
    lastSequence: 0,
    emergencyActive: false,
    panicRaisedAt: null,
    closedAt: null,
  };

  it('panik tek onay adımıyla, Idempotency-Key olmadan gönderilir; 112 yolu gösterilir', async () => {
    let raised = false;
    const { calls } = customerBackend({
      '/bookings/b-1/safety-session': () =>
        json({
          ...SESSION_VIEW,
          emergencyActive: raised,
          panicRaisedAt: raised ? '2026-10-12T08:00:00Z' : null,
        }),
      'POST /safety/sessions/ss-1/panic': () => {
        raised = true;
        return json(
          {
            sessionId: 'ss-1',
            eventId: 'e-1',
            raisedAt: '2026-10-12T08:00:00Z',
            duplicate: false,
            bookingHoldApplied: true,
          },
          201,
        );
      },
    });
    renderScreen(<SafetyScreen bookingId="b-1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Acil durum' }));
    await userEvent.click(screen.getByRole('button', { name: 'Evet, acil durum bildir' }));
    expect(await screen.findByText('Acil durum kaydınız alındı')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '112’yi ara' })).toHaveAttribute('href', 'tel:112');
    const panic = calls.find((c) => c.path === '/safety/sessions/ss-1/panic');
    expect(panic?.headers.has('Idempotency-Key')).toBe(false);
    expect(panic?.body).toEqual({});
  });

  it('PRE_SERVICE: backend paniği kabul etmez — buton yerine 112 yolu gösterilir', async () => {
    const { calls } = customerBackend({
      '/bookings/b-1/safety-session': () => json({ ...SESSION_VIEW, status: 'PRE_SERVICE' }),
    });
    renderScreen(<SafetyScreen bookingId="b-1" />);
    expect(await screen.findByText('Hizmet saatinde başlayacak')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Acil durum' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '112’yi ara' })).toHaveAttribute('href', 'tel:112');
    expect(calls.some((c) => c.path.endsWith('/panic'))).toBe(false);
  });

  it('oturum henüz yoksa bilgi verir, panik butonu göstermez', async () => {
    customerBackend({
      '/bookings/b-1/safety-session': () =>
        apiError(404, 'SAFETY_SESSION_NOT_FOUND', 'Oturum bulunamadı.'),
    });
    renderScreen(<SafetyScreen bookingId="b-1" />);
    expect(await screen.findByText('Güvenlik oturumu henüz başlamadı')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Acil durum' })).not.toBeInTheDocument();
  });
});

describe('Dijital ispat', () => {
  it('yalnızca yüklenmiş kanıtları sha256 ile listeler; imzalı URL tıklamada alınır', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const { calls } = customerBackend({
      '/bookings/b-1/documents': () =>
        json([
          {
            id: 'doc-1',
            bookingId: 'b-1',
            documentType: 'BEFORE_PHOTO',
            contentType: 'image/jpeg',
            sizeBytes: '1000',
            sha256: 'a'.repeat(64),
            status: 'AVAILABLE',
            uploadedAt: '2026-10-12T07:05:00Z',
            createdAt: '2026-10-12T07:04:00Z',
          },
          {
            id: 'doc-2',
            bookingId: 'b-1',
            documentType: 'AFTER_PHOTO',
            contentType: 'image/jpeg',
            sizeBytes: null,
            sha256: null,
            status: 'PENDING_UPLOAD',
            uploadedAt: null,
            createdAt: '2026-10-12T09:00:00Z',
          },
        ]),
      '/documents/doc-1/download-url': () =>
        json({ url: 'https://storage.googleapis.com/signed', expiresAt: '2026-10-12T07:10:00Z' }),
    });
    renderScreen(<ProofScreen bookingId="b-1" />);
    expect(await screen.findByText('a'.repeat(64))).toBeInTheDocument();
    expect(screen.queryByText('Sonra')).not.toBeInTheDocument();
    expect(calls.some((c) => c.path.includes('download-url'))).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Görüntüle' }));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        'https://storage.googleapis.com/signed',
        '_blank',
        'noopener,noreferrer',
      ),
    );
  });
});

describe('Müşteri profili olmayan kullanıcı', () => {
  it('müşteri ekranında profil oluşturma yolu görür', async () => {
    mockBackend({
      '/auth/session': () => json({ ...SESSION, roles: ['CUSTOMER', 'PROVIDER'] }),
      '/customers/me': () => apiError(404, 'PROFILE_NOT_FOUND', 'yok'),
      '/providers/me': () =>
        json({
          userId: 'u-1',
          displayName: 'Hatice',
          bio: null,
          experienceYears: null,
          ratingAvg: null,
          ratingCount: 0,
          maxDailyBookings: 3,
          state: 'APPROVED',
          createdAt: '',
          updatedAt: '',
        }),
    });
    renderScreen(<BookingsList />);
    expect(
      await screen.findByText('Hizmet almak için müşteri profili gerekli'),
    ).toBeInTheDocument();
  });
});
