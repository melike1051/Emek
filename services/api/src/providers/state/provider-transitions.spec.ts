import { PROVIDER_STATES } from '../providers.service';
import {
  PROVIDER_TRANSITIONS,
  findProviderTransition,
  isProviderActorAllowed,
} from './provider-transitions';

describe('provider transition map', () => {
  it('taslak -> incelemede -> onaylı mutlu yolu tanımlıdır', () => {
    expect(findProviderTransition('DRAFT', 'PENDING_REVIEW')).toBeDefined();
    expect(findProviderTransition('PENDING_REVIEW', 'APPROVED')).toBeDefined();
  });

  it('adım atlayan geçiş tanımlı değildir', () => {
    expect(findProviderTransition('DRAFT', 'APPROVED')).toBeUndefined();
    expect(findProviderTransition('DRAFT', 'SUSPENDED')).toBeUndefined();
  });

  it('yalnızca sağlayıcının kendisi başvuru gönderebilir', () => {
    const rule = findProviderTransition('DRAFT', 'PENDING_REVIEW');
    expect(isProviderActorAllowed(rule!, 'PROVIDER')).toBe(true);
    expect(isProviderActorAllowed(rule!, 'ADMIN')).toBe(false);
    expect(isProviderActorAllowed(rule!, 'CUSTOMER')).toBe(false);
  });

  it('yalnızca operatör onaylayabilir/reddedebilir/askıya alabilir', () => {
    for (const [from, to] of [
      ['PENDING_REVIEW', 'APPROVED'],
      ['PENDING_REVIEW', 'REJECTED'],
      ['APPROVED', 'SUSPENDED'],
      ['SUSPENDED', 'APPROVED'],
    ] as const) {
      const rule = findProviderTransition(from, to);
      expect(rule).toBeDefined();
      expect(rule!.actors).toEqual(['ADMIN']);
    }
  });

  it('SUPPORT rolü hiçbir geçişi tetikleyemez', () => {
    for (const rule of PROVIDER_TRANSITIONS) {
      expect(isProviderActorAllowed(rule, 'SUPPORT')).toBe(false);
    }
  });

  it('reddedilen sağlayıcı yeniden başvurabilir', () => {
    const rule = findProviderTransition('REJECTED', 'PENDING_REVIEW');
    expect(rule).toBeDefined();
    expect(isProviderActorAllowed(rule!, 'PROVIDER')).toBe(true);
  });

  it('askıya alınmış sağlayıcı doğrudan reddedilemez veya taslağa dönemez', () => {
    expect(findProviderTransition('SUSPENDED', 'REJECTED')).toBeUndefined();
    expect(findProviderTransition('SUSPENDED', 'DRAFT')).toBeUndefined();
  });

  it('reddedilmiş durumdan doğrudan onaya geçilemez — yeniden inceleme şart', () => {
    expect(findProviderTransition('REJECTED', 'APPROVED')).toBeUndefined();
  });

  it('her geçiş bilinen durumlar arasındadır ve en az bir aktörü vardır', () => {
    for (const rule of PROVIDER_TRANSITIONS) {
      expect(PROVIDER_STATES).toContain(rule.from);
      expect(PROVIDER_STATES).toContain(rule.to);
      expect(rule.actors.length).toBeGreaterThan(0);
      expect(rule.from).not.toBe(rule.to);
    }
  });

  it('aynı geçiş iki kez tanımlanmamıştır', () => {
    const keys = PROVIDER_TRANSITIONS.map((rule) => `${rule.from}->${rule.to}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
