import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import {
  ADMIN_SESSION,
  SUPPORT_SESSION,
  apiError,
  json,
  mockBackend,
  navigation,
  page,
  renderScreen,
  router,
} from './harness';
import { OverviewScreen } from '@/app/(app)/OverviewScreen';
import { ProvidersScreen } from '@/app/(app)/saglayicilar/ProvidersScreen';
import { PaymentsScreen } from '@/app/(app)/odemeler/PaymentsScreen';
import { RecoveryScreen } from '@/app/(app)/kimlik-kurtarma/RecoveryScreen';
import { SessionDetail } from '@/app/(app)/guvenlik/[sessionId]/SessionDetail';
import { OpsScreen } from '@/app/(app)/operasyon/OpsScreen';
import { DisputesScreen } from '@/app/(app)/itirazlar/DisputesScreen';

vi.mock('next/navigation', () => import('./navigation-mock').then((m) => m.nextNavigationMock));

const session = (body: object) => ({ 'POST /auth/session': () => json(body) });

const PROVIDER = {
  userId: '11111111-1111-4111-8111-111111111111',
  displayName: 'Hatice Yılmaz',
  bio: 'Temizlik',
  experienceYears: 4,
  ratingAvg: null,
  ratingCount: 0,
  maxDailyBookings: 3,
  state: 'PENDING_REVIEW',
  createdAt: '2026-09-01T10:00:00Z',
  updatedAt: '2026-09-01T10:00:00Z',
};

const PAYMENT = {
  id: '22222222-2222-4222-8222-222222222222',
  bookingId: '33333333-3333-4333-8333-333333333333',
  amountMinor: '150000',
  currency: 'TRY',
  refundedMinor: '0',
  status: 'SERVICE_COMPLETED',
  authorizationExpiresAt: '2026-10-01T10:00:00Z',
  releasedAt: null,
};

beforeEach(() => {
  navigation.pathname = '/';
  navigation.search = new URLSearchParams();
  router.replace.mockClear();
});

afterEach(() => vi.unstubAllGlobals());

describe('oturum kapısı', () => {
  it('giriş yoksa giriş sayfasına yönlendirir', async () => {
    mockBackend({});
    navigation.pathname = '/odemeler';
    renderScreen(<p>içerik</p>, { signedIn: false });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/giris?next=%2Fodemeler'));
  });

  it('derin bağlantının sorgu dizesi girişten sonra korunur', async () => {
    mockBackend({});
    navigation.pathname = '/odemeler';
    window.history.replaceState(null, '', '/odemeler?bookingId=b-1');
    try {
      renderScreen(<p>içerik</p>, { signedIn: false });
      await waitFor(() =>
        expect(router.replace).toHaveBeenCalledWith(
          `/giris?next=${encodeURIComponent('/odemeler?bookingId=b-1')}`,
        ),
      );
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('personel rolü olmayan kullanıcı içeri alınmaz', async () => {
    mockBackend(session({ ...ADMIN_SESSION, roles: ['CUSTOMER'] }));
    renderScreen(<p>gizli içerik</p>);
    expect(await screen.findByText('Bu alan operasyon ekibine özeldir')).toBeInTheDocument();
    expect(screen.queryByText('gizli içerik')).not.toBeInTheDocument();
  });
});

describe('sağlayıcı onay kuyruğu', () => {
  it('SUPPORT listeyi görür ama hiçbir karar düğmesi görmez', async () => {
    mockBackend({
      ...session(SUPPORT_SESSION),
      '/providers/queue': () => json(page([PROVIDER])),
      '/ops/health': () => json({}),
    });
    renderScreen(<ProvidersScreen />);
    expect(await screen.findByText('Hatice Yılmaz')).toBeInTheDocument();
    expect(screen.getByText('SUPPORT · salt okunur')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Onayla' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reddet' })).not.toBeInTheDocument();
  });

  it('ret gerekçe ister; ağ hatası sonrası girdiler kilitlenir, tekrar aynı anahtarla gider', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const backend = mockBackend({
      ...session(ADMIN_SESSION),
      '/providers/queue': (_m, _b, url) => {
        expect(url.searchParams.get('state')).toBe('PENDING_REVIEW');
        return json(page([PROVIDER]));
      },
      [`POST /providers/${PROVIDER.userId}/reject`]: () => {
        attempt += 1;
        if (attempt === 1) throw new TypeError('ağ koptu');
        return json({ ...PROVIDER, state: 'REJECTED' });
      },
    });
    renderScreen(<ProvidersScreen />);
    await user.click(await screen.findByRole('button', { name: 'Reddet' }));
    const panel = screen.getByRole('group', { name: 'Başvuruyu reddet' });
    const confirm = within(panel).getByRole('button', { name: 'Reddet' });
    expect(confirm).toBeDisabled();

    await user.type(within(panel).getByLabelText('Ret gerekçesi'), 'ab');
    expect(within(panel).getByText('En az 3 karakter yazın.')).toBeInTheDocument();
    expect(confirm).toBeDisabled();
    await user.type(within(panel).getByLabelText('Ret gerekçesi'), 'c eksik belge');
    await user.click(confirm);
    expect(await within(panel).findByRole('alert')).toHaveTextContent('Bağlantı');
    expect(within(panel).getByLabelText('Ret gerekçesi')).toBeDisabled();
    expect(within(panel).getByText(/sunucuda gerçekleşmiş olabilir/)).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Tekrar dene' }));
    await waitFor(() => expect(attempt).toBe(2));
    const [first, second] = backend.find('POST', `/providers/${PROVIDER.userId}/reject`);
    expect(first!.body).toEqual({ reason: 'abc eksik belge' });
    expect(second!.headers.get('Idempotency-Key')).toBe(first!.headers.get('Idempotency-Key'));
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Başvuruyu reddet' })).not.toBeInTheDocument(),
    );
  });

  it('5xx sonrası gerekçe değiştirilemez; tekrar aynı gövde ve anahtarla gider (çift işlem yok)', async () => {
    const user = userEvent.setup();
    const backend = mockBackend({
      ...session(ADMIN_SESSION),
      '/providers/queue': () => json(page([PROVIDER])),
      [`POST /providers/${PROVIDER.userId}/reject`]: () =>
        apiError(503, 'SERVICE_UNAVAILABLE', 'Servis geçici olarak kullanılamıyor.'),
    });
    renderScreen(<ProvidersScreen />);
    await user.click(await screen.findByRole('button', { name: 'Reddet' }));
    const panel = screen.getByRole('group', { name: 'Başvuruyu reddet' });
    const field = within(panel).getByLabelText('Ret gerekçesi');
    await user.type(field, 'eksik belge');
    await user.click(within(panel).getByRole('button', { name: 'Reddet' }));
    await within(panel).findByRole('alert');
    expect(field).toBeDisabled();
    await user.type(field, 'ler');
    expect(field).toHaveValue('eksik belge');
    await user.click(within(panel).getByRole('button', { name: 'Tekrar dene' }));
    await waitFor(() =>
      expect(backend.find('POST', `/providers/${PROVIDER.userId}/reject`)).toHaveLength(2),
    );
    const [a, b] = backend.find('POST', `/providers/${PROVIDER.userId}/reject`);
    expect(b!.body).toEqual(a!.body);
    expect(b!.headers.get('Idempotency-Key')).toBe(a!.headers.get('Idempotency-Key'));
  });

  it('kesin ret (4xx) sonrası gerekçe değişirse anahtar yenilenir (farklı gövde aynı anahtarı taşımaz)', async () => {
    const user = userEvent.setup();
    const backend = mockBackend({
      ...session(ADMIN_SESSION),
      '/providers/queue': () => json(page([PROVIDER])),
      [`POST /providers/${PROVIDER.userId}/reject`]: () =>
        apiError(
          409,
          'INVALID_STATE_TRANSITION',
          'Bu işlem sağlayıcının mevcut durumunda yapılamaz.',
        ),
    });
    renderScreen(<ProvidersScreen />);
    await user.click(await screen.findByRole('button', { name: 'Reddet' }));
    const panel = screen.getByRole('group', { name: 'Başvuruyu reddet' });
    const field = within(panel).getByLabelText('Ret gerekçesi');
    await user.type(field, 'eksik belge');
    await user.click(within(panel).getByRole('button', { name: 'Reddet' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'Bu işlem sağlayıcının mevcut durumunda yapılamaz. (Referans: req-1)',
    );
    await user.type(field, 'ler');
    await user.click(within(panel).getByRole('button', { name: 'Tekrar dene' }));
    await waitFor(() =>
      expect(backend.find('POST', `/providers/${PROVIDER.userId}/reject`)).toHaveLength(2),
    );
    const [a, b] = backend.find('POST', `/providers/${PROVIDER.userId}/reject`);
    expect(a!.headers.get('Idempotency-Key')).not.toBe(b!.headers.get('Idempotency-Key'));
  });
});

describe('ödemeler', () => {
  it('randevudan gelen filtreyi uygular; serbest bırakma çift onay ister', async () => {
    const user = userEvent.setup();
    navigation.search = new URLSearchParams({ bookingId: PAYMENT.bookingId });
    const backend = mockBackend({
      ...session(ADMIN_SESSION),
      '/payments/admin': () => json(page([PAYMENT])),
      [`POST /payments/${PAYMENT.id}/release`]: () => json({ ...PAYMENT, status: 'RELEASED' }),
    });
    renderScreen(<PaymentsScreen />);
    await user.click(await screen.findByRole('button', { name: 'Serbest bırak' }));
    expect(backend.find('GET', '/payments/admin')[0]!.url.searchParams.get('bookingId')).toBe(
      PAYMENT.bookingId,
    );
    const panel = screen.getByRole('group', { name: /sağlayıcıya serbest bırakılsın mı/ });
    const confirm = within(panel).getByRole('button', { name: 'Serbest bırak' });
    expect(confirm).toBeDisabled();
    await user.click(within(panel).getByRole('checkbox'));
    await user.click(confirm);
    await waitFor(() =>
      expect(backend.find('POST', `/payments/${PAYMENT.id}/release`)).toHaveLength(1),
    );
    expect(
      backend.find('POST', `/payments/${PAYMENT.id}/release`)[0]!.headers.get('Idempotency-Key'),
    ).toBeTruthy();
    // başarı → liste tazelenir
    await waitFor(() => expect(backend.find('GET', '/payments/admin').length).toBeGreaterThan(1));
  });

  it('kısmi iade tutarı minor unit metni olarak gider; geçersiz tutar onayı kapatır', async () => {
    const user = userEvent.setup();
    const backend = mockBackend({
      ...session(ADMIN_SESSION),
      '/payments/admin': () => json(page([PAYMENT])),
      [`POST /payments/${PAYMENT.id}/refund`]: () => json({ ...PAYMENT, refundedMinor: '15050' }),
    });
    renderScreen(<PaymentsScreen />);
    await user.click(await screen.findByRole('button', { name: 'İade et' }));
    const panel = screen.getByRole('group', { name: 'İade' });
    await user.type(within(panel).getByLabelText('Tutar (₺, isteğe bağlı)'), '150,5x');
    await user.type(within(panel).getByLabelText('İade gerekçesi'), 'Eksik hizmet');
    await user.click(within(panel).getByRole('checkbox'));
    expect(within(panel).getByRole('button', { name: 'İade et' })).toBeDisabled();
    await user.type(within(panel).getByLabelText('Tutar (₺, isteğe bağlı)'), '{Backspace}');
    await user.click(within(panel).getByRole('button', { name: 'İade et' }));
    await waitFor(() =>
      expect(backend.find('POST', `/payments/${PAYMENT.id}/refund`)).toHaveLength(1),
    );
    expect(backend.find('POST', `/payments/${PAYMENT.id}/refund`)[0]!.body).toEqual({
      reason: 'Eksik hizmet',
      amountMinor: '15050',
    });
  });

  it('serbest bırakılmış ödemede para düğmesi yoktur', async () => {
    mockBackend({
      ...session(ADMIN_SESSION),
      '/payments/admin': () =>
        json(page([{ ...PAYMENT, status: 'REFUNDED', refundedMinor: '150000' }])),
    });
    renderScreen(<PaymentsScreen />);
    expect(await screen.findByText('İade edildi')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Serbest bırak' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'İade et' })).not.toBeInTheDocument();
  });
});

describe('kimlik kurtarma', () => {
  it('R-36 reddi backend mesajıyla gösterilir', async () => {
    const user = userEvent.setup();
    mockBackend({
      ...session(ADMIN_SESSION),
      '/verification/recovery-requests': () =>
        json(
          page([
            {
              id: '44444444-4444-4444-8444-444444444444',
              requesterUserId: 'op-1',
              targetUserId: '55555555-5555-4555-8555-555555555555',
              status: 'PENDING_REVIEW',
              assuranceLevel: 'HIGH',
              createdAt: '2026-09-01T10:00:00Z',
              decidedAt: null,
              decidedBy: null,
              decisionReason: null,
            },
          ]),
        ),
      'POST /verification/recovery-requests/44444444-4444-4444-8444-444444444444/approve': () =>
        apiError(403, 'FORBIDDEN', 'Talebin tarafı olan operatör karar veremez.'),
    });
    renderScreen(<RecoveryScreen />);
    await user.click(await screen.findByRole('button', { name: 'Onayla' }));
    const panel = screen.getByRole('group', { name: 'Kurtarmayı onayla' });
    await user.click(within(panel).getByRole('checkbox'));
    await user.click(within(panel).getByRole('button', { name: 'Onayla' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'Talebin tarafı olan operatör karar veremez.',
    );
  });
});

const SESSION_DETAIL = {
  sessionId: '66666666-6666-4666-8666-666666666666',
  bookingId: PAYMENT.bookingId,
  providerId: 'p',
  customerId: 'c',
  status: 'ACTIVE',
  riskLevel: 'NORMAL',
  geofenceState: 'INSIDE',
  lastDistanceMeters: 12,
  lastTelemetryAt: null,
  telemetryCount: 3,
  rejectedCount: 0,
  integrityRejectionCount: 0,
  mockLocationCount: 0,
  activeRules: [],
  anomalyFlagged: false,
  emergencyActive: false,
  panicRaisedAt: null,
  scheduledStart: '2026-09-28T10:00:00Z',
  scheduledEnd: '2026-09-28T12:00:00Z',
  closedAt: null,
  closureReason: null,
  retentionExpiresAt: '2026-10-28T10:00:00Z',
  locationPurgedAt: null,
  assessments: [],
  events: [],
};

describe('güvenlik oturumu', () => {
  const detailPath = `/safety/operator/sessions/${SESSION_DETAIL.sessionId}`;

  it('ham konum: gerekçe + riskli olmayan oturumda cam kırma beyanı ister; sonuç gizlenebilir', async () => {
    const user = userEvent.setup();
    const backend = mockBackend({
      ...session(ADMIN_SESSION),
      [detailPath]: () => json(SESSION_DETAIL),
      [`${detailPath}/locations`]: () =>
        json({
          sessionId: SESSION_DETAIL.sessionId,
          locationPurgedAt: null,
          locations: [
            {
              sequence: 1,
              capturedAt: '2026-09-28T10:01:00Z',
              receivedAt: '2026-09-28T10:01:02Z',
              latitude: 41.0,
              longitude: 39.7,
              accuracyMeters: 8,
              isMockLocation: true,
              distanceMeters: 12,
              geofenceState: 'INSIDE',
            },
          ],
        }),
    });
    renderScreen(<SessionDetail sessionId={SESSION_DETAIL.sessionId} />);
    const show = await screen.findByRole('button', { name: 'Konum izini göster' });
    await user.type(screen.getByLabelText('Erişim amacı'), 'Müşteri şikâyeti incelemesi');
    expect(show).toBeDisabled();
    await user.click(screen.getByRole('checkbox'));
    await user.click(show);
    expect(await screen.findByText('Ham konum izi (1 nokta)')).toBeInTheDocument();
    expect(screen.getByText('EVET')).toBeInTheDocument();
    const call = backend.find('GET', `${detailPath}/locations`)[0]!;
    expect(call.url.searchParams.get('reason')).toBe('Müşteri şikâyeti incelemesi');
    expect(call.url.searchParams.get('breakGlass')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Gizle' }));
    expect(screen.queryByText('41.00000')).not.toBeInTheDocument();
  });

  it('SUPPORT ham konum alanını ve oturum eylemlerini görmez', async () => {
    mockBackend({ ...session(SUPPORT_SESSION), [detailPath]: () => json(SESSION_DETAIL) });
    renderScreen(<SessionDetail sessionId={SESSION_DETAIL.sessionId} />);
    expect(await screen.findByText('Değerlendirmeler')).toBeInTheDocument();
    expect(screen.queryByText('Ham konum izi')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Oturumu kapat' })).not.toBeInTheDocument();
  });

  it('risk kararı düzey, gerekçe ve taban süresiyle gider', async () => {
    const user = userEvent.setup();
    const backend = mockBackend({
      ...session(ADMIN_SESSION),
      [detailPath]: () => json(SESSION_DETAIL),
      [`POST ${detailPath}/risk`]: () => json(SESSION_DETAIL),
    });
    renderScreen(<SessionDetail sessionId={SESSION_DETAIL.sessionId} />);
    await user.click(await screen.findByRole('button', { name: 'Risk düzeyini değiştir' }));
    const panel = screen.getByRole('group', { name: 'Operatör risk kararı' });
    await user.selectOptions(within(panel).getByLabelText('Yeni risk düzeyi'), 'HIGH_RISK');
    await user.clear(within(panel).getByLabelText('Taban süresi (dakika)'));
    await user.type(within(panel).getByLabelText('Taban süresi (dakika)'), '60');
    await user.type(within(panel).getByLabelText('Gerekçe'), 'Sağlayıcı ulaşılamıyor');
    await user.click(within(panel).getByRole('button', { name: 'Kararı uygula' }));
    await waitFor(() => expect(backend.find('POST', `${detailPath}/risk`)).toHaveLength(1));
    expect(backend.find('POST', `${detailPath}/risk`)[0]!.body).toEqual({
      riskLevel: 'HIGH_RISK',
      reason: 'Sağlayıcı ulaşılamıyor',
      floorMinutes: 60,
    });
  });
});

describe('operasyon', () => {
  it('DLQ sonraki sayfayı opak cursor ile ister', async () => {
    const user = userEvent.setup();
    const row = (id: string) => ({
      id,
      eventId: 'e',
      eventType: 'booking.confirmed',
      eventVersion: 1,
      consumer: 'notifications',
      payload: { bookingId: 'b' },
      attemptCount: 5,
      failureClassification: 'PERMANENT',
      failureReason: 'şablon yok',
      firstFailureAt: '2026-09-01T10:00:00Z',
      lastFailureAt: '2026-09-01T10:05:00Z',
      resolvedAt: null,
      createdAt: '2026-09-01T10:00:00Z',
    });
    const backend = mockBackend({
      ...session(SUPPORT_SESSION),
      '/ops/dead-letter': (_m, _b, url) =>
        url.searchParams.get('cursor') === 'c2'
          ? json(page([row('2')]))
          : json(page([row('1')], 'c2')),
    });
    renderScreen(<OpsScreen />);
    await user.click(await screen.findByRole('button', { name: 'Daha fazla yükle' }));
    await waitFor(() => expect(screen.getAllByText('booking.confirmed')).toHaveLength(2));
    const calls = backend.find('GET', '/ops/dead-letter');
    expect(calls[0]!.url.searchParams.get('resolved')).toBe('false');
    expect(calls[1]!.url.searchParams.get('cursor')).toBe('c2');
    // SUPPORT: kapatma düğmesi yok
    expect(screen.queryByRole('button', { name: 'Çözüldü işaretle' })).not.toBeInTheDocument();
  });

  it('saklama taraması onay kutusu olmadan çalışmaz; sonucu gösterir', async () => {
    const user = userEvent.setup();
    mockBackend({
      ...session(ADMIN_SESSION),
      '/ops/dead-letter': () => json(page([])),
      '/ops/audit-chain': () =>
        json({
          status: 'BROKEN',
          rowsVerified: 0,
          verifiedThroughId: '10',
          brokenAtId: '10',
          exportedStorageKey: null,
        }),
      'POST /ops/retention/sweep': () =>
        json({
          anonymizedUsers: 2,
          processedEvents: 40,
          deadLetterEvents: 1,
          verificationAttempts: 3,
          analyticsEvents: 0,
        }),
    });
    renderScreen(<OpsScreen />);
    await user.click(await screen.findByRole('tab', { name: 'Denetim ve saklama' }));
    expect(await screen.findByText('Kopukluk bulundu')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Taramayı çalıştır' }));
    const panel = screen.getByRole('group', { name: 'Saklama taramasını şimdi çalıştır' });
    expect(within(panel).getByRole('button', { name: 'Çalıştır' })).toBeDisabled();
    await user.click(within(panel).getByRole('checkbox'));
    await user.click(within(panel).getByRole('button', { name: 'Çalıştır' }));
    const result = await screen.findByRole('status');
    expect(within(result).getByText('40')).toBeInTheDocument();
  });
});

describe('itirazlar', () => {
  it('karar gövdesi sonuç, gerekçe ve iade kararını taşır', async () => {
    const user = userEvent.setup();
    const dispute = {
      id: '77777777-7777-4777-8777-777777777777',
      bookingId: PAYMENT.bookingId,
      reason: 'DAMAGE',
      description: 'Vazo kırıldı',
      status: 'OPEN',
      resolution: null,
      refundAmountMinor: null,
      createdAt: '2026-09-01T10:00:00Z',
      resolvedAt: null,
    };
    const backend = mockBackend({
      ...session(ADMIN_SESSION),
      '/disputes/admin': (_m, _b, url) => {
        expect(url.searchParams.get('status')).toBe('OPEN');
        return json(page([dispute]));
      },
      [`POST /disputes/${dispute.id}/resolve`]: () =>
        json({ ...dispute, status: 'RESOLVED_CUSTOMER' }),
    });
    renderScreen(<DisputesScreen />);
    expect(await screen.findByText('Hasar')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Karara bağla' }));
    const panel = screen.getByRole('group', { name: 'İtirazı karara bağla' });
    await user.type(within(panel).getByLabelText('Karara bağlanan iade (₺, isteğe bağlı)'), '200');
    await user.type(
      within(panel).getByLabelText('Karar gerekçesi'),
      'Fotoğraf kanıtı hasarı doğruluyor',
    );
    await user.click(within(panel).getByRole('checkbox'));
    await user.click(within(panel).getByRole('button', { name: 'Kararı kaydet' }));
    await waitFor(() =>
      expect(backend.find('POST', `/disputes/${dispute.id}/resolve`)).toHaveLength(1),
    );
    expect(backend.find('POST', `/disputes/${dispute.id}/resolve`)[0]!.body).toEqual({
      status: 'RESOLVED_CUSTOMER',
      resolution: 'Fotoğraf kanıtı hasarı doğruluyor',
      refundAmountMinor: '20000',
    });
  });
});

describe('genel bakış', () => {
  it('bir kartın hatası diğerlerini düşürmez', async () => {
    mockBackend({
      ...session(SUPPORT_SESSION),
      '/ops/health': () =>
        apiError(503, 'SERVICE_UNAVAILABLE', 'Servis geçici olarak kullanılamıyor.'),
      '/ops/audit-chain': () =>
        json({
          status: 'OK',
          rowsVerified: 0,
          verifiedThroughId: '99',
          brokenAtId: null,
          exportedStorageKey: null,
        }),
      '/analytics/export/status': () =>
        json({ unexportedCount: 5, oldestUnexportedAgeMs: 120_000, lastExportedAt: null }),
      '/matching/admin/stats': () =>
        json({
          sinceDays: 7,
          totalRuns: 10,
          degradedRuns: 1,
          degradedRate: 0.1,
          byStrategy: [],
          byDegradedReason: [{ reason: 'AI_UNAVAILABLE', count: 1 }],
          avgCandidateCount: 4,
          avgRetrievalMs: 20,
          avgDecisionMs: 35,
        }),
    });
    renderScreen(<OverviewScreen />);
    expect(await screen.findByText('Sağlam')).toBeInTheDocument();
    expect(await screen.findByText('2 dk')).toBeInTheDocument();
    expect(await screen.findByText('1 (%10.0)')).toBeInTheDocument();
    expect(
      await screen.findByText('Servis geçici olarak kullanılamıyor.', {}, { timeout: 4000 }),
    ).toBeInTheDocument();
  });
});
