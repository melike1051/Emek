import { isAtLeastAssurance, isAtLeastLevel } from './identity.types';

describe('doğrulama seviyesi sıralaması', () => {
  it('daha yüksek seviye gerekliyi karşılar', () => {
    expect(isAtLeastLevel('IDENTITY_VERIFIED', 'PHONE_VERIFIED')).toBe(true);
    expect(isAtLeastLevel('FULLY_VERIFIED', 'IDENTITY_VERIFIED')).toBe(true);
  });

  it('düşük seviye gerekliyi karşılamaz', () => {
    expect(isAtLeastLevel('PHONE_VERIFIED', 'IDENTITY_VERIFIED')).toBe(false);
    expect(isAtLeastLevel('UNVERIFIED', 'PHONE_VERIFIED')).toBe(false);
  });

  it('aynı seviye yeterlidir', () => {
    expect(isAtLeastLevel('IDENTITY_VERIFIED', 'IDENTITY_VERIFIED')).toBe(true);
  });
});

describe('güvence seviyesi sıralaması', () => {
  // ADR-0005: NFC tek başına kart sahipliğini kanıtlamaz; recovery HIGH ister.
  it('LOW, HIGH gerektiren akışa yetmez', () => {
    expect(isAtLeastAssurance('LOW', 'HIGH')).toBe(false);
    expect(isAtLeastAssurance('SUBSTANTIAL', 'HIGH')).toBe(false);
  });

  it('HIGH her gereksinimi karşılar', () => {
    expect(isAtLeastAssurance('HIGH', 'HIGH')).toBe(true);
    expect(isAtLeastAssurance('HIGH', 'LOW')).toBe(true);
  });
});
