import { createHmac } from 'node:crypto';
import { IdentityHasher, type IdentityMacProvider } from './identity-hasher';

function createHasher(keyMaterial = 'test-key-that-is-long-enough-0001'): IdentityHasher {
  const provider: IdentityMacProvider = {
    version: 'test:v1',
    mac: async (message) => createHmac('sha256', keyMaterial).update(message).digest(),
  };
  return new IdentityHasher(provider);
}

describe('IdentityHasher', () => {
  it('aynı girdi için aynı hash üretir', async () => {
    const hasher = createHasher();

    expect(await hasher.hash('12345678901')).toBe(await hasher.hash('12345678901'));
  });

  it('64 karakterlik hex üretir', async () => {
    expect(await createHasher().hash('12345678901')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('farklı kimlik farklı hash üretir', async () => {
    const hasher = createHasher();

    expect(await hasher.hash('12345678901')).not.toBe(await hasher.hash('12345678902'));
  });

  // Biçim farkı aynı kişi için farklı hash üretirse tekillik kontrolü atlanabilir.
  it('boşluk ve harf büyüklüğü farkını normalize eder', async () => {
    const hasher = createHasher();
    const canonical = await hasher.hash('12345678901');

    expect(await hasher.hash(' 12345678901 ')).toBe(canonical);
    expect(await hasher.hash('123 456 789 01')).toBe(canonical);
    expect(await hasher.hash('ab12345678901'.toUpperCase())).toBe(
      await hasher.hash('ab12345678901'),
    );
  });

  // ADR-0004 §4: anahtarsız hash 11 haneli uzayda brute-force edilebilir. Anahtar
  // değişince hash de değişmeli — yani hash gerçekten anahtara bağlı olmalı.
  it('farklı anahtar farklı hash üretir', async () => {
    const first = await createHasher('key-one-that-is-long-enough-0001').hash('12345678901');
    const second = await createHasher('key-two-that-is-long-enough-0002').hash('12345678901');

    expect(first).not.toBe(second);
  });

  it('hash girdinin kendisini içermez', async () => {
    const hash = await createHasher().hash('12345678901');

    expect(hash).not.toContain('12345678901');
  });

  it('boş kimlik referansı reddedilir', async () => {
    await expect(createHasher().hash('   ')).rejects.toThrow();
  });

  it('anahtar sürümü raporlanır (teşhis için)', () => {
    expect(createHasher().keyVersion).toBe('test:v1');
  });

  // KMS yanlış algoritmalı bir anahtarla yapılandırılmışsa etiket 32 bayt olmaz.
  // Bunu sessizce hex'e çevirmek, kısa (dolayısıyla zayıf) bir "hash" üretirdi.
  it('32 bayt olmayan MAC etiketi reddedilir', async () => {
    const hasher = new IdentityHasher({
      version: 'test:short',
      mac: async () => Buffer.alloc(16, 1),
    });

    await expect(hasher.hash('12345678901')).rejects.toThrow(/32 bayt/);
  });

  // Uygulama anahtarı görmez: port yalnızca mesajı verir, etiketi alır (R-39).
  it('MAC sağlayıcısına yalnızca normalize edilmiş mesaj geçilir', async () => {
    const seen: string[] = [];
    const hasher = new IdentityHasher({
      version: 'test:v1',
      mac: async (message) => {
        seen.push(message.toString('utf8'));
        return createHmac('sha256', 'k').update(message).digest();
      },
    });

    await hasher.hash(' 123 456 78901 ');

    expect(seen).toEqual(['12345678901']);
  });

  it('sabit zamanlı karşılaştırma doğru sonuç verir', async () => {
    const hasher = createHasher();
    const hash = await hasher.hash('12345678901');

    expect(hasher.equals(hash, hash)).toBe(true);
    expect(hasher.equals(hash, await hasher.hash('12345678902'))).toBe(false);
    expect(hasher.equals(hash, 'kısa')).toBe(false);
  });
});
