import { BOOKING_STATUSES, blocksPaymentRelease, isTerminal } from './booking-status';
import { TRANSITIONS, allowedTargets, findTransition, isActorAllowed } from './transitions';

describe('booking transition map', () => {
  it('ana mutlu yol baştan sona tanımlıdır', () => {
    const happyPath = [
      'REQUESTED',
      'MATCHED',
      'PROVIDER_PENDING',
      'CONFIRMED',
      'PAYMENT_AUTHORIZED',
      'SCHEDULED',
      'PROVIDER_ARRIVING',
      'CHECKED_IN',
      'IN_PROGRESS',
      'CHECKED_OUT',
      'CUSTOMER_CONFIRMED',
      'COMPLETED',
      'SETTLED',
    ] as const;

    for (let index = 0; index < happyPath.length - 1; index += 1) {
      const from = happyPath[index] as (typeof happyPath)[number];
      const to = happyPath[index + 1] as (typeof happyPath)[number];
      expect(findTransition(from, to)).toBeDefined();
    }
  });

  it('adım atlayan geçiş tanımlı değildir', () => {
    expect(findTransition('REQUESTED', 'COMPLETED')).toBeUndefined();
    expect(findTransition('REQUESTED', 'IN_PROGRESS')).toBeUndefined();
    expect(findTransition('CONFIRMED', 'SETTLED')).toBeUndefined();
  });

  it('geriye dönüş tanımlı değildir', () => {
    expect(findTransition('CONFIRMED', 'REQUESTED')).toBeUndefined();
    expect(findTransition('IN_PROGRESS', 'CHECKED_IN')).toBeUndefined();
  });

  it('terminal durumlardan çıkış yoktur', () => {
    expect(allowedTargets('SETTLED')).toEqual([]);
    expect(allowedTargets('CANCELLED')).toEqual([]);
    expect(isTerminal('SETTLED')).toBe(true);
    expect(isTerminal('CANCELLED')).toBe(true);
    expect(isTerminal('IN_PROGRESS')).toBe(false);
  });

  /**
   * Hizmet başladıktan sonra **taraflar** iptal edemez: para ve emek harcanmıştır.
   * Ancak güvenlik dışı bir aksaklıkta rezervasyon sıkışmamalı; bu durumda iptal
   * operatör kararıdır (Faz 4 review bulgusu).
   */
  it('hizmet başladıktan sonra iptal yalnızca operatöre açıktır', () => {
    for (const from of ['CHECKED_IN', 'IN_PROGRESS', 'CHECKED_OUT'] as const) {
      const rule = findTransition(from, 'CANCELLED');

      expect(rule).toBeDefined();
      expect(rule!.actors).toEqual(['ADMIN']);
      expect(isActorAllowed(rule!, 'CUSTOMER')).toBe(false);
      expect(isActorAllowed(rule!, 'PROVIDER')).toBe(false);
    }
  });

  it('tamamlanmış rezervasyon iptal edilemez (yol dispute.tur)', () => {
    expect(findTransition('COMPLETED', 'CANCELLED')).toBeUndefined();
    expect(findTransition('COMPLETED', 'DISPUTED')).toBeDefined();
  });

  it('hizmet öncesi her aşamadan iptal edilebilir', () => {
    for (const from of ['REQUESTED', 'CONFIRMED', 'SCHEDULED', 'PROVIDER_ARRIVING'] as const) {
      expect(findTransition(from, 'CANCELLED')).toBeDefined();
    }
  });

  it('SUPPORT rolü hiçbir geçişi tetikleyemez', () => {
    // ADR-0013 §4: SUPPORT okuma + not ekler, yıkıcı/ilerletici aksiyon yapamaz.
    for (const rule of TRANSITIONS) {
      expect(isActorAllowed(rule, 'SUPPORT')).toBe(false);
    }
  });

  it('müşteri sağlayıcının check-in.ini yapamaz', () => {
    const rule = findTransition('PROVIDER_ARRIVING', 'CHECKED_IN');

    expect(rule).toBeDefined();
    expect(isActorAllowed(rule!, 'CUSTOMER')).toBe(false);
    expect(isActorAllowed(rule!, 'PROVIDER')).toBe(true);
  });

  it('sağlayıcı müşteri onayını veremez', () => {
    const rule = findTransition('CHECKED_OUT', 'CUSTOMER_CONFIRMED');

    expect(isActorAllowed(rule!, 'PROVIDER')).toBe(false);
    expect(isActorAllowed(rule!, 'CUSTOMER')).toBe(true);
  });

  it('güvenlik askısı yalnızca sistem veya operatör tarafından konur', () => {
    const rule = findTransition('IN_PROGRESS', 'SAFETY_HOLD');

    expect(rule).toBeDefined();
    expect(isActorAllowed(rule!, 'SYSTEM')).toBe(true);
    expect(isActorAllowed(rule!, 'ADMIN')).toBe(true);
    expect(isActorAllowed(rule!, 'CUSTOMER')).toBe(false);
    expect(isActorAllowed(rule!, 'PROVIDER')).toBe(false);
  });

  it('güvenlik askısından çıkış yalnızca operatör kararıyla olur', () => {
    for (const to of ['IN_PROGRESS', 'CANCELLED', 'DISPUTED'] as const) {
      const rule = findTransition('SAFETY_HOLD', to);
      expect(rule).toBeDefined();
      expect(rule!.actors).toEqual(['ADMIN']);
    }
  });

  it('SAFETY_HOLD ve DISPUTED ödeme serbest bırakmayı bloklar', () => {
    expect(blocksPaymentRelease('SAFETY_HOLD')).toBe(true);
    expect(blocksPaymentRelease('DISPUTED')).toBe(true);
    expect(blocksPaymentRelease('COMPLETED')).toBe(false);
  });

  it('her geçiş bilinen durumlar arasındadır ve en az bir aktörü vardır', () => {
    for (const rule of TRANSITIONS) {
      expect(BOOKING_STATUSES).toContain(rule.from);
      expect(BOOKING_STATUSES).toContain(rule.to);
      expect(rule.actors.length).toBeGreaterThan(0);
      expect(rule.from).not.toBe(rule.to);
    }
  });

  it('aynı geçiş iki kez tanımlanmamıştır', () => {
    const keys = TRANSITIONS.map((rule) => `${rule.from}->${rule.to}`);

    expect(new Set(keys).size).toBe(keys.length);
  });

  // Her durum ya bir yerden erişilebilir olmalı ya da başlangıç durumu olmalı;
  // erişilemeyen durum, ölü kod veya eksik geçiş demektir.
  it('REQUESTED dışındaki her durum bir geçişin hedefidir', () => {
    const reachable = new Set(TRANSITIONS.map((rule) => rule.to));
    const unreachable = BOOKING_STATUSES.filter(
      (status) => status !== 'REQUESTED' && !reachable.has(status),
    );

    expect(unreachable).toEqual([]);
  });
});
