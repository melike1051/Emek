import { createHmac } from 'node:crypto';
import { crc32c } from './crc32c';
import { KmsIdentityMacProvider } from './kms-identity-mac-provider';

const KEY_NAME =
  'projects/emek/locations/europe-west1/keyRings/emek/cryptoKeys/identity-hash/cryptoKeyVersions/3';

function createClient(impl: (request: { name?: string | null; data?: unknown }) => unknown): {
  macSign: jest.Mock;
} {
  return { macSign: jest.fn(async (request) => [impl(request)]) };
}

describe('KmsIdentityMacProvider', () => {
  const validTag = () => createHmac('sha256', 'k').update('m').digest();

  it('mesajı yapılandırılmış anahtar sürümüyle ve checksum ile imzalar', async () => {
    const client = createClient(() => ({ mac: validTag(), verifiedDataCrc32c: true }));
    const provider = new KmsIdentityMacProvider(client as never, KEY_NAME);
    const message = Buffer.from('12345678901', 'utf8');

    await provider.mac(message);

    // Checksum gönderilmezse KMS `verifiedDataCrc32c` alanını **her zaman** false
    // döndürür; o durumda doğrulama kontrolü her çağrıyı düşürürdü.
    expect(client.macSign).toHaveBeenCalledWith({
      name: KEY_NAME,
      data: message,
      dataCrc32c: { value: crc32c(message) },
    });
  });

  it('checksum teslim alınmadıysa (alan unset/false) reddeder', async () => {
    const client = createClient(() => ({ mac: validTag() }));

    await expect(
      new KmsIdentityMacProvider(client as never, KEY_NAME).mac(Buffer.from('x')),
    ).rejects.toThrow(/CRC32C/);
  });

  // Rotasyon yoktur: başka bir sürümle üretilen etiket aynı kişi için farklı hash demektir.
  it('yanıt farklı anahtar sürümü bildirirse reddeder', async () => {
    const client = createClient(() => ({
      mac: validTag(),
      verifiedDataCrc32c: true,
      name: KEY_NAME.replace('/3', '/4'),
    }));

    await expect(
      new KmsIdentityMacProvider(client as never, KEY_NAME).mac(Buffer.from('x')),
    ).rejects.toThrow(/farklı anahtar sürümü/);
  });

  it('sürüm etiketi anahtar sürümünü taşır (teşhis)', () => {
    expect(new KmsIdentityMacProvider(createClient(() => ({})) as never, KEY_NAME).version).toBe(
      'kms:3',
    );
  });

  // KMS veriyi bozuk aldıysa etiket başka bir mesaja aittir: sessizce kabul etmek
  // aynı kişi için farklı hash üretip tekilliği delerdi.
  it('CRC32C doğrulanmadıysa reddeder', async () => {
    const client = createClient(() => ({ mac: validTag(), verifiedDataCrc32c: false }));

    await expect(
      new KmsIdentityMacProvider(client as never, KEY_NAME).mac(Buffer.from('x')),
    ).rejects.toThrow(/CRC32C/);
  });

  it('boş etiket reddedilir', async () => {
    const client = createClient(() => ({ mac: null }));

    await expect(
      new KmsIdentityMacProvider(client as never, KEY_NAME).mac(Buffer.from('x')),
    ).rejects.toThrow(/boş etiket/);
  });

  // Anahtar yanlış algoritmayla (ör. HMAC_SHA512) oluşturulmuşsa boot durmalı.
  it('yanlış algoritmalı anahtarla boot başarısız olur', async () => {
    const client = createClient(() => ({ mac: Buffer.alloc(64, 7), verifiedDataCrc32c: true }));

    await expect(
      new KmsIdentityMacProvider(client as never, KEY_NAME).onApplicationBootstrap(),
    ).rejects.toThrow(/HMAC_SHA256/);
  });

  it('doğru anahtarla boot kanaryası geçer', async () => {
    const client = createClient(() => ({ mac: validTag(), verifiedDataCrc32c: true }));

    await expect(
      new KmsIdentityMacProvider(client as never, KEY_NAME).onApplicationBootstrap(),
    ).resolves.toBeUndefined();
  });
});
