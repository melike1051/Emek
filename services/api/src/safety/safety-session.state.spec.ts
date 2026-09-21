import { BOOKING_STATUSES } from '../bookings/state/booking-status';
import { findTransition } from '../bookings/state/transitions';
import {
  SAFETY_TRANSITIONS,
  forwardPath,
  isAllowedSafetyTransition,
  safetyEffectForBooking,
} from './safety-session.state';

/**
 * Oturum yaşam döngüsü booking'i izler; ikinci bir iş yaşam döngüsü değildir.
 */
describe('safety session state', () => {
  it('geri gitmek ve kapalıdan çıkmak tanımlı değildir', () => {
    expect(isAllowedSafetyTransition('ACTIVE', 'ARRIVAL_MONITORING')).toBe(false);
    expect(isAllowedSafetyTransition('CLOSED', 'ACTIVE')).toBe(false);
    expect(isAllowedSafetyTransition('CLOSED', 'PRE_SERVICE')).toBe(false);
    for (const rule of SAFETY_TRANSITIONS) {
      expect(rule.from).not.toBe('CLOSED');
    }
  });

  it('adım atlanmaz: ileri yol tablodaki adımlardan geçer', () => {
    expect(isAllowedSafetyTransition('PRE_SERVICE', 'ACTIVE')).toBe(false);
    expect(forwardPath('PRE_SERVICE', 'ACTIVE')).toEqual(['ARRIVAL_MONITORING', 'ACTIVE']);
    expect(forwardPath('ACTIVE', 'ACTIVE')).toEqual([]);
    expect(forwardPath('ACTIVE', 'PRE_SERVICE')).toBeNull();
    expect(forwardPath('CLOSED', 'CLOSED')).toEqual([]);
    expect(forwardPath('CLOSED', 'ACTIVE')).toBeNull();
  });

  it('rezervasyon var diye oturum açılmaz: yalnızca ödemesi alınmış randevu', () => {
    for (const status of ['REQUESTED', 'MATCHED', 'PROVIDER_PENDING', 'CONFIRMED'] as const) {
      expect(safetyEffectForBooking(status)).toBeNull();
    }
    expect(safetyEffectForBooking('SCHEDULED')).toEqual({ target: 'PRE_SERVICE' });
  });

  it('telemetri yola çıkışta açılır, check-out ile kapanır', () => {
    expect(safetyEffectForBooking('PROVIDER_ARRIVING')?.target).toBe('ARRIVAL_MONITORING');
    expect(safetyEffectForBooking('CHECKED_IN')?.target).toBe('ACTIVE');
    expect(safetyEffectForBooking('CHECKED_OUT')).toEqual({
      target: 'CLOSED',
      closureReason: 'SERVICE_COMPLETED',
    });
    expect(safetyEffectForBooking('CANCELLED')).toEqual({
      target: 'CLOSED',
      closureReason: 'BOOKING_CANCELLED',
    });
  });

  it('güvenlik askısı izlemeyi kapatmaz', () => {
    expect(safetyEffectForBooking('SAFETY_HOLD')).toBeNull();
  });

  it('eşleme booking state machine ile tutarlıdır: her hedef bir booking geçişinin sonucudur', () => {
    for (const status of BOOKING_STATUSES) {
      if (safetyEffectForBooking(status) === null) {
        continue;
      }
      const reachable = BOOKING_STATUSES.some((from) => findTransition(from, status) !== undefined);
      expect(reachable).toBe(true);
    }
  });
});
