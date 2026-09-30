import {
  addDays,
  formatRadius,
  groupByDay,
  istanbulDay,
  istanbulToIso,
  providerActions,
  readiness,
  weekStart,
} from './provider';

describe('İstanbul saati', () => {
  it("yerel saati UTC ISO'ya çevirir (sabit +03:00, yaz saati yok)", () => {
    expect(istanbulToIso('2026-10-12', '09:30')).toBe('2026-10-12T06:30:00.000Z');
    expect(istanbulToIso('2026-01-15', '00:00')).toBe('2026-01-14T21:00:00.000Z');
  });

  it('geçersiz girdi null döner', () => {
    expect(istanbulToIso('2026-13-40', '09:00')).toBeNull();
    expect(istanbulToIso('12.10.2026', '09:00')).toBeNull();
    expect(istanbulToIso('2026-10-12', '9')).toBeNull();
  });

  it('UTC gece yarısına yakın an İstanbul gününe göre gruplanır', () => {
    expect(istanbulDay('2026-10-11T22:30:00.000Z')).toBe('2026-10-12');
  });

  it('hafta pazartesi başlar; pazar önceki haftaya aittir; ay/yıl sınırı aşılır', () => {
    expect(weekStart('2026-10-07')).toBe('2026-10-05'); // çarşamba
    expect(weekStart('2026-10-11')).toBe('2026-10-05'); // pazar
    expect(weekStart('2026-10-05')).toBe('2026-10-05');
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
  });

  it('pencereler 7 güne dağıtılır ve saate göre sıralanır', () => {
    const days = groupByDay(
      [
        { id: 'b', startsAt: '2026-10-06T12:00:00.000Z', endsAt: '2026-10-06T14:00:00.000Z' },
        { id: 'a', startsAt: '2026-10-06T06:00:00.000Z', endsAt: '2026-10-06T08:00:00.000Z' },
        { id: 'x', startsAt: '2026-10-20T06:00:00.000Z', endsAt: '2026-10-20T08:00:00.000Z' },
      ],
      '2026-10-05',
    );
    expect(days).toHaveLength(7);
    expect(days[1]!.windows.map((w) => w.id)).toEqual(['a', 'b']);
    expect(days.flatMap((d) => d.windows).some((w) => w.id === 'x')).toBe(false);
  });
});

describe('sağlayıcı eylemleri (transition map aynası)', () => {
  it('hizmet günü adımları sırayla ilerler', () => {
    expect(providerActions('SCHEDULED').next?.to).toBe('PROVIDER_ARRIVING');
    expect(providerActions('PROVIDER_ARRIVING').next?.to).toBe('CHECKED_IN');
    expect(providerActions('CHECKED_IN').next?.to).toBe('IN_PROGRESS');
    expect(providerActions('IN_PROGRESS').next?.to).toBe('CHECKED_OUT');
    // Müşteri onayı sağlayıcıya ait değildir.
    expect(providerActions('CHECKED_OUT').next).toBeNull();
  });

  it('hizmet adresi yalnız planlanmış randevudan check-out’a kadar istenir (R-102)', () => {
    for (const status of [
      'SCHEDULED',
      'PROVIDER_ARRIVING',
      'CHECKED_IN',
      'IN_PROGRESS',
      'CHECKED_OUT',
    ]) {
      expect(providerActions(status).address).toBe('VISIBLE');
    }
    for (const status of ['PROVIDER_PENDING', 'CONFIRMED', 'PAYMENT_AUTHORIZED']) {
      expect(providerActions(status).address).toBe('AFTER_PAYMENT');
    }
    for (const status of ['COMPLETED', 'SETTLED', 'CANCELLED', 'DISPUTED', 'SAFETY_HOLD']) {
      expect(providerActions(status).address).toBe('CLOSED');
    }
  });

  it("yanıt yalnızca PROVIDER_PENDING'de; hizmet başladıktan sonra taraf iptal edemez", () => {
    expect(providerActions('PROVIDER_PENDING').canRespond).toBe(true);
    expect(providerActions('CONFIRMED').canRespond).toBe(false);
    expect(providerActions('PROVIDER_ARRIVING').canCancel).toBe(true);
    for (const status of ['CHECKED_IN', 'IN_PROGRESS', 'CHECKED_OUT', 'COMPLETED']) {
      expect(providerActions(status).canCancel).toBe(false);
    }
  });

  it('önce fotoğrafı hizmet başında, sonra fotoğrafı hizmet sonunda eklenir', () => {
    expect(providerActions('PROVIDER_ARRIVING').uploadable).toEqual([]);
    expect(providerActions('CHECKED_IN').uploadable).toEqual(['BEFORE_PHOTO']);
    expect(providerActions('IN_PROGRESS').uploadable).toEqual(['BEFORE_PHOTO', 'AFTER_PHOTO']);
    expect(providerActions('CHECKED_OUT').uploadable).toEqual(['AFTER_PHOTO']);
    expect(providerActions('COMPLETED').uploadable).toEqual([]);
  });
});

describe('hazırlık', () => {
  it('pasif hizmet/bölge ve boş tanıtım eksik sayılır', () => {
    const items = readiness({
      bio: '   ',
      services: [{ serviceId: 's', slug: 's', name: 's', active: false }],
      areas: [{ id: 'a', name: 'a', latitude: 0, longitude: 0, radiusMeters: 500, active: false }],
      upcomingAvailability: 0,
      identityVerified: false,
    });
    expect(items.every((item) => !item.done)).toBe(true);
    expect(items.find((item) => item.key === 'identity')?.href).toBeNull();
  });

  it('yarıçap okunur biçimde yazılır', () => {
    expect(formatRadius(500)).toBe('500 m');
    expect(formatRadius(5000)).toBe('5 km');
    expect(formatRadius(2500)).toBe('2,5 km');
  });
});
