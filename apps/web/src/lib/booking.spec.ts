import {
  BOOKING_STATUS_VIEW,
  customerActions,
  explanationText,
  formatMoney,
  formatRange,
  isActiveBooking,
  needsReview,
} from './booking';
import { buildWindow, windowFromIso } from './request-form';

describe('formatMoney', () => {
  it('minor unit string’i hassasiyet kaybı olmadan biçimlendirir', () => {
    expect(formatMoney('150000', 'TRY')).toBe('1.500,00 ₺');
    expect(formatMoney('5', 'TRY')).toBe('0,05 ₺');
    // Number'a çevrilseydi son haneler kaybolurdu.
    expect(formatMoney('900719925474099312', 'TRY')).toBe('9.007.199.254.740.993,12 ₺');
    expect(formatMoney('-250', 'EUR')).toBe('-2,50 EUR');
  });

  it('beklenmeyen biçimi olduğu gibi gösterir, çökmez', () => {
    expect(formatMoney('abc', 'TRY')).toBe('abc TRY');
  });
});

describe('customerActions — transition map aynası', () => {
  it('ödeme yalnızca CONFIRMED durumunda', () => {
    expect(customerActions('CONFIRMED').canPay).toBe(true);
    expect(customerActions('PROVIDER_PENDING').canPay).toBe(false);
    expect(customerActions('SCHEDULED').canPay).toBe(false);
  });

  it('hizmet başladıktan sonra taraf iptal edemez', () => {
    expect(customerActions('PROVIDER_ARRIVING').canCancel).toBe(true);
    for (const status of ['CHECKED_IN', 'IN_PROGRESS', 'CHECKED_OUT', 'COMPLETED']) {
      expect(customerActions(status).canCancel).toBe(false);
    }
  });

  it('hizmet onayı CHECKED_OUT, değerlendirme COMPLETED/SETTLED, itiraz pencere durumlarında', () => {
    expect(customerActions('CHECKED_OUT').canConfirmService).toBe(true);
    expect(customerActions('COMPLETED').canReview).toBe(true);
    expect(customerActions('SETTLED').canReview).toBe(true);
    expect(customerActions('CANCELLED').canReview).toBe(false);
    expect(customerActions('CHECKED_OUT').canDispute).toBe(true);
    expect(customerActions('SETTLED').canDispute).toBe(false);
  });

  it('her booking durumunun müşteri etiketi var; bitmiş durumlar geçmişe düşer', () => {
    expect(Object.keys(BOOKING_STATUS_VIEW)).toHaveLength(16);
    expect(isActiveBooking('SCHEDULED')).toBe(true);
    expect(isActiveBooking('DISPUTED')).toBe(true);
    expect(isActiveBooking('SETTLED')).toBe(false);
  });
});

describe('explanationText', () => {
  it('kodu Türkçe metne, değeri bağlama çevirir', () => {
    expect(explanationText('NEARBY', 3)).toBe('Yaklaşık 3 km uzaklıkta');
    expect(explanationText('HIGH_RATING', 4.8)).toBe('Yüksek puanlı (4,8/5)');
  });

  it('bilinmeyen kod ham hâliyle gösterilmez', () => {
    expect(explanationText('SECRET_SCORE_COMPONENT', 0.91)).toBeNull();
  });
});

describe('needsReview', () => {
  it('eşiğin altı uyarı; form yolu (null) uyarı değil', () => {
    expect(needsReview(0.65)).toBe(true);
    expect(needsReview(0.95)).toBe(false);
    expect(needsReview(null)).toBe(false);
  });
});

describe('formatRange', () => {
  it('aynı gün aralığını tek tarihle yazar (İstanbul saati)', () => {
    const text = formatRange('2026-10-12T07:00:00.000Z', '2026-10-12T09:00:00.000Z');
    expect(text).toContain('10:00');
    expect(text).toContain('12:00');
    expect(text.match(/2026/g)).toHaveLength(1);
  });
});

describe('buildWindow', () => {
  const now = new Date('2026-10-01T00:00:00Z');
  const base = { date: '2026-10-12', from: '10:00', to: '14:00', durationMinutes: 120 };

  it('İstanbul saatini UTC ISO’ya çevirir', () => {
    expect(buildWindow(base, now)).toEqual({
      ok: true,
      preferredStart: '2026-10-12T07:00:00.000Z',
      preferredEnd: '2026-10-12T11:00:00.000Z',
    });
  });

  it('geçersiz aralıkları backend’e gitmeden reddeder', () => {
    expect(buildWindow({ ...base, to: '09:00' }, now).ok).toBe(false);
    expect(buildWindow({ ...base, durationMinutes: 300 }, now).ok).toBe(false);
    expect(buildWindow({ ...base, durationMinutes: 15 }, now).ok).toBe(false);
    expect(buildWindow({ ...base, date: '2026-09-01' }, now).ok).toBe(false);
    expect(buildWindow({ ...base, date: '' }, now).ok).toBe(false);
  });

  it('windowFromIso buildWindow’un tersidir', () => {
    expect(windowFromIso('2026-10-12T07:00:00.000Z', '2026-10-12T11:00:00.000Z')).toEqual({
      date: '2026-10-12',
      from: '10:00',
      to: '14:00',
    });
  });
});
