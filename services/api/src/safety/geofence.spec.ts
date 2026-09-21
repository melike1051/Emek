import { applyDebounce, evaluateGeofence, hysteresisMeters, type DebounceState } from './geofence';
import type { GeofenceState } from './safety.constants';

/**
 * Geofence (T-21): sonuç ikili değildir ve jitter olay üretmez.
 */
describe('evaluateGeofence', () => {
  const base = { radiusMeters: 150, accuracyLimitMeters: 100 };

  it('belirsizlik dairesi tamamen içerideyse INSIDE', () => {
    expect(evaluateGeofence({ ...base, distanceMeters: 40, accuracyMeters: 10 }).state).toBe(
      'INSIDE',
    );
  });

  it('belirsizlik dairesi tamamen dışarıdaysa OUTSIDE', () => {
    expect(evaluateGeofence({ ...base, distanceMeters: 900, accuracyMeters: 20 }).state).toBe(
      'OUTSIDE',
    );
  });

  it('daire sınırı kesiyorsa BOUNDARY (kesin yargı yok)', () => {
    expect(evaluateGeofence({ ...base, distanceMeters: 150, accuracyMeters: 10 }).state).toBe(
      'BOUNDARY',
    );
  });

  it('histerezis bandı: sınırın hemen içi/dışı kesin sayılmaz', () => {
    const band = hysteresisMeters(150);

    expect(band).toBe(15);
    expect(evaluateGeofence({ ...base, distanceMeters: 140, accuracyMeters: 2 }).state).toBe(
      'BOUNDARY',
    );
    expect(evaluateGeofence({ ...base, distanceMeters: 160, accuracyMeters: 2 }).state).toBe(
      'BOUNDARY',
    );
  });

  it('küçük yarıçapta da bant en az 10 m', () => {
    expect(hysteresisMeters(25)).toBe(10);
  });

  it('doğruluk sınırın üstündeyse INSUFFICIENT_ACCURACY — "dışarıda" değil', () => {
    // Kapalı alanda zayıf sinyal: konum 5 km uzakta görünse bile yargı yok.
    expect(evaluateGeofence({ ...base, distanceMeters: 5000, accuracyMeters: 400 }).state).toBe(
      'INSUFFICIENT_ACCURACY',
    );
  });
});

describe('applyDebounce', () => {
  const threshold = 3;

  function run(start: GeofenceState, observations: GeofenceState[]) {
    let state: DebounceState = { current: start, candidate: null, candidateCount: 0 };
    const transitions: GeofenceState[] = [];
    for (const observation of observations) {
      const result = applyDebounce(state, observation, threshold);
      state = result.next;
      if (result.transitioned) {
        transitions.push(state.current);
      }
    }
    return { state, transitions };
  }

  it('giriş, ardışık eşik kadar gözlemden sonra kabul edilir', () => {
    expect(run('OUTSIDE', ['INSIDE', 'INSIDE']).transitions).toEqual([]);
    expect(run('OUTSIDE', ['INSIDE', 'INSIDE', 'INSIDE']).transitions).toEqual(['INSIDE']);
  });

  it('çıkış da debounce edilir', () => {
    expect(run('INSIDE', ['OUTSIDE', 'OUTSIDE', 'OUTSIDE']).transitions).toEqual(['OUTSIDE']);
  });

  it('sınırda zıplayan jitter hiç olay üretmez', () => {
    const jitter: GeofenceState[] = ['OUTSIDE', 'INSIDE', 'OUTSIDE', 'INSIDE', 'OUTSIDE', 'INSIDE'];

    const { state, transitions } = run('INSIDE', jitter);

    expect(transitions).toEqual([]);
    expect(state.current).toBe('INSIDE');
  });

  it('tekrarlanan giriş/çıkış bastırılır: yalnızca kalıcı değişim olay olur', () => {
    const { transitions } = run('INSIDE', [
      'OUTSIDE',
      'OUTSIDE',
      'INSIDE',
      'OUTSIDE',
      'OUTSIDE',
      'OUTSIDE',
      'INSIDE',
    ]);

    expect(transitions).toEqual(['OUTSIDE']);
  });

  it('belirsiz gözlemler (BOUNDARY/INSUFFICIENT_ACCURACY) durumu değiştirmez ve adayı sıfırlar', () => {
    const { state, transitions } = run('INSIDE', [
      'OUTSIDE',
      'OUTSIDE',
      'INSUFFICIENT_ACCURACY',
      'OUTSIDE',
      'BOUNDARY',
    ]);

    expect(transitions).toEqual([]);
    expect(state.current).toBe('INSIDE');
    expect(state.candidateCount).toBe(0);
  });

  it('UNKNOWN başlangıçtan ilk kesin durum kabul edilir', () => {
    expect(run('UNKNOWN', ['OUTSIDE', 'OUTSIDE', 'OUTSIDE']).transitions).toEqual(['OUTSIDE']);
  });
});
