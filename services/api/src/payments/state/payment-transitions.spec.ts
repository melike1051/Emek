import {
  PAYMENT_STATUSES,
  holdsAuthorization,
  isTerminalPayment,
  progressRank,
} from './payment-status';
import {
  PAYMENT_TRANSITIONS,
  findPaymentTransition,
  isBackwardProgress,
  isSourceAllowed,
} from './payment-transitions';

describe('payment transition map', () => {
  it('mutlu yol baştan sona tanımlıdır', () => {
    const happyPath = [
      'CREATED',
      'AUTHORIZED',
      'HELD',
      'SERVICE_COMPLETED',
      'RELEASE_PENDING',
      'RELEASED',
    ] as const;

    for (let index = 0; index < happyPath.length - 1; index += 1) {
      expect(findPaymentTransition(happyPath[index]!, happyPath[index + 1]!)).toBeDefined();
    }
  });

  it('adım atlayan geçiş tanımlı değildir', () => {
    expect(findPaymentTransition('CREATED', 'RELEASED')).toBeUndefined();
    expect(findPaymentTransition('AUTHORIZED', 'RELEASE_PENDING')).toBeUndefined();
    expect(findPaymentTransition('HELD', 'RELEASED')).toBeUndefined();
  });

  /**
   * Out-of-order webhook teslimi kaçınılmazdır (T-10). Geri geçiş hem transition
   * map'te tanımsızdır hem de sıralama kontrolüyle ayrıca reddedilir.
   */
  it('gecikmiş olay ödemeyi geriye çekemez', () => {
    expect(isBackwardProgress('RELEASED', 'AUTHORIZED')).toBe(true);
    expect(isBackwardProgress('HELD', 'CREATED')).toBe(true);
    expect(isBackwardProgress('AUTHORIZED', 'HELD')).toBe(false);
    expect(findPaymentTransition('RELEASED', 'AUTHORIZED')).toBeUndefined();
  });

  it('yan durumlar sırasızdır: iade geri geçiş sayılmaz', () => {
    // `REFUNDED` ilerleme sırasında yer almaz; iade "geriye gitmek" değildir.
    expect(progressRank('REFUNDED')).toBeNull();
    expect(isBackwardProgress('RELEASED', 'REFUNDED')).toBe(false);
    expect(findPaymentTransition('RELEASED', 'REFUNDED')).toBeDefined();
  });

  it('terminal durumlardan çıkış yoktur', () => {
    for (const status of ['RELEASED', 'FAILED', 'AUTHORIZATION_EXPIRED'] as const) {
      const outgoing = PAYMENT_TRANSITIONS.filter((rule) => rule.from === status);
      // `RELEASED` yalnızca iadeye açıktır; diğerlerinden hiçbir çıkış yoktur.
      const allowed = status === 'RELEASED' ? ['REFUNDED', 'DISPUTED'] : [];
      expect(outgoing.map((rule) => rule.to).sort()).toEqual(allowed.sort());
    }
    expect(isTerminalPayment('REFUNDED')).toBe(true);
    expect(isTerminalPayment('HELD')).toBe(false);
  });

  /**
   * ADR-0009 §6: para hareketi event'ten tetiklenmez. Webhook durumu **hizalar**;
   * release/iade kararı yalnızca Emek'in senkron komutundan gelir.
   */
  it('release ve iade kararı webhook ile başlatılamaz', () => {
    const toReleasePending = findPaymentTransition('SERVICE_COMPLETED', 'RELEASE_PENDING');
    expect(toReleasePending).toBeDefined();
    expect(isSourceAllowed(toReleasePending!, 'WEBHOOK')).toBe(false);
    expect(isSourceAllowed(toReleasePending!, 'COMMAND')).toBe(true);

    const disputeRefund = findPaymentTransition('DISPUTED', 'REFUNDED');
    expect(isSourceAllowed(disputeRefund!, 'WEBHOOK')).toBe(false);
  });

  it('uyuşmazlıktan çıkış yalnızca komutla olur', () => {
    for (const to of ['REFUNDED', 'RELEASE_PENDING'] as const) {
      const rule = findPaymentTransition('DISPUTED', to);
      expect(rule).toBeDefined();
      expect(rule!.sources).toEqual(['COMMAND']);
    }
  });

  it('süresi dolma her yetkilendirilmiş durumdan mümkündür', () => {
    for (const from of ['AUTHORIZED', 'HELD', 'SERVICE_COMPLETED'] as const) {
      expect(findPaymentTransition(from, 'AUTHORIZATION_EXPIRED')).toBeDefined();
      expect(holdsAuthorization(from)).toBe(true);
    }
    // Serbest bırakılmış para "süresi doldu" olamaz: para zaten çıkmıştır.
    expect(findPaymentTransition('RELEASED', 'AUTHORIZATION_EXPIRED')).toBeUndefined();
  });

  it('yetkilendirilmiş ödeme FAILED olamaz (iade yolu kullanılır)', () => {
    expect(findPaymentTransition('CREATED', 'FAILED')).toBeDefined();
    expect(findPaymentTransition('HELD', 'FAILED')).toBeUndefined();
    expect(findPaymentTransition('HELD', 'REFUNDED')).toBeDefined();
  });

  it('her geçiş bilinen durumlar arasındadır ve en az bir kaynağı vardır', () => {
    for (const rule of PAYMENT_TRANSITIONS) {
      expect(PAYMENT_STATUSES).toContain(rule.from);
      expect(PAYMENT_STATUSES).toContain(rule.to);
      expect(rule.sources.length).toBeGreaterThan(0);
      expect(rule.from).not.toBe(rule.to);
    }
  });

  it('aynı geçiş iki kez tanımlanmamıştır', () => {
    const keys = PAYMENT_TRANSITIONS.map((rule) => `${rule.from}->${rule.to}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('CREATED dışındaki her durum bir geçişin hedefidir', () => {
    const reachable = new Set(PAYMENT_TRANSITIONS.map((rule) => rule.to));
    const unreachable = PAYMENT_STATUSES.filter(
      (status) => status !== 'CREATED' && !reachable.has(status),
    );
    expect(unreachable).toEqual([]);
  });
});
