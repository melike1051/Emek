import { ParticipantRateLimiter } from './participant-rate-limiter';

describe('ParticipantRateLimiter', () => {
  const start = 1_000_000 * 60_000;

  it('pencere içinde sınıra kadar izin verir, sonra reddeder', () => {
    const limiter = new ParticipantRateLimiter();

    const results = Array.from({ length: 4 }, () => limiter.consume('u1', 3, 60, start + 10));

    expect(results).toEqual([true, true, true, false]);
  });

  it('sayaç kullanıcıya özeldir: bir kullanıcı başkasını sınırlayamaz', () => {
    const limiter = new ParticipantRateLimiter();
    for (let index = 0; index < 10; index += 1) {
      limiter.consume('attacker', 3, 60, start);
    }

    expect(limiter.consume('victim', 3, 60, start)).toBe(true);
  });

  it('yeni pencerede sayaç sıfırlanır', () => {
    const limiter = new ParticipantRateLimiter();
    for (let index = 0; index < 5; index += 1) {
      limiter.consume('u1', 3, 60, start);
    }

    expect(limiter.consume('u1', 3, 60, start + 60_000)).toBe(true);
  });
});
