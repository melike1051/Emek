import { describe, expect, it } from 'vitest';
import { forwardedClientIp } from './client-ip';

describe('forwardedClientIp (R-107)', () => {
  it('hopCount=1: en sağdaki girdi (Next’in yazdığı soket ya da ön ucun eklediği adres)', () => {
    expect(forwardedClientIp('203.0.113.7', 1)).toBe('203.0.113.7');
    expect(forwardedClientIp('6.6.6.6, 203.0.113.7', 1)).toBe('203.0.113.7');
  });

  it('sahte sol önek seçimi değiştiremez', () => {
    expect(forwardedClientIp('1.1.1.1, 2.2.2.2, 203.0.113.7, 35.191.0.1', 2)).toBe('203.0.113.7');
  });

  it('zincir kısa, adres geçersiz veya hop sayısı geçersizse null (başlık eklenmez)', () => {
    expect(forwardedClientIp('203.0.113.7', 2)).toBeNull();
    expect(forwardedClientIp(null, 1)).toBeNull();
    expect(forwardedClientIp('evil', 1)).toBeNull();
    expect(forwardedClientIp('203.0.113.7', 0)).toBeNull();
    expect(forwardedClientIp('203.0.113.7', Number.NaN)).toBeNull();
  });

  it('IPv4-mapped IPv6 normalleştirilir; IPv6 kabul edilir', () => {
    expect(forwardedClientIp('::ffff:203.0.113.7', 1)).toBe('203.0.113.7');
    expect(forwardedClientIp('2001:db8::1', 1)).toBe('2001:db8::1');
  });
});
