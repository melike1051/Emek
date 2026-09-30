import { formatAge, formatMoney, parseMoneyToMinor, uuidOrUndefined } from './format';
import { bookingStatusView, paymentStatusView } from './labels';
import { canWrite, isStaff } from './session';
import { parseAdminEnv } from './env';

describe('para', () => {
  it('minor unit string sayıya çevrilmeden biçimlenir', () => {
    expect(formatMoney('150000', 'TRY')).toBe('1.500,00 ₺');
    expect(formatMoney('900719925474099312', 'TRY')).toBe('9.007.199.254.740.993,12 ₺');
  });

  it('operatör tutarı minor unit metnine çevrilir; sıfır/negatif/fazla kuruş reddedilir', () => {
    expect(parseMoneyToMinor('150')).toBe('15000');
    expect(parseMoneyToMinor('150,5')).toBe('15050');
    expect(parseMoneyToMinor(' 150.05 ')).toBe('15005');
    expect(parseMoneyToMinor('0')).toBeNull();
    expect(parseMoneyToMinor('-5')).toBeNull();
    expect(parseMoneyToMinor('1,234')).toBeNull();
    expect(parseMoneyToMinor('1.500,00')).toBeNull();
    expect(parseMoneyToMinor('abc')).toBeNull();
  });
});

describe('biçim', () => {
  it('süreler okunur biçimde', () => {
    expect(formatAge(null)).toBe('—');
    expect(formatAge(45_000)).toBe('45 sn');
    expect(formatAge(12 * 60_000)).toBe('12 dk');
    expect(formatAge(185 * 60_000)).toBe('3 sa 5 dk');
    expect(formatAge(49 * 3_600_000)).toBe('2 gün');
  });

  it('yalnızca tam UUID filtreye yazılır', () => {
    expect(uuidOrUndefined('  3f0c9a4e-1b2c-4d5e-8f90-123456789abc ')).toBe(
      '3f0c9a4e-1b2c-4d5e-8f90-123456789abc',
    );
    expect(uuidOrUndefined('3f0c9a4e')).toBeUndefined();
    expect(uuidOrUndefined('d783a3b3-0000-0000-0000-000000000000')).toBeUndefined();
    expect(uuidOrUndefined('')).toBeUndefined();
  });

  it('bilinmeyen durum kodu ham adıyla nötr gösterilir', () => {
    expect(bookingStatusView('NEW_STATE')).toEqual({ label: 'NEW_STATE', tone: 'neutral' });
    expect(paymentStatusView('RELEASED').label).toBe('Serbest bırakıldı');
  });
});

describe('oturum', () => {
  it('yalnız ADMIN/SUPPORT personeldir; yazma yalnız ADMIN', () => {
    expect(isStaff({ userId: 'u', roles: ['CUSTOMER', 'PROVIDER'] })).toBe(false);
    expect(isStaff({ userId: 'u', roles: ['SUPPORT'] })).toBe(true);
    expect(canWrite({ userId: 'u', roles: ['SUPPORT'] })).toBe(false);
    expect(canWrite({ userId: 'u', roles: ['ADMIN'] })).toBe(true);
  });

  it('mock giriş production build ile başlamaz', () => {
    expect(() => parseAdminEnv({ NEXT_PUBLIC_AUTH_MODE: 'mock' }, 'production')).toThrow();
    expect(parseAdminEnv({ NEXT_PUBLIC_AUTH_MODE: 'mock' }, 'development').authMode).toBe('mock');
  });
});
