import { crc32c } from './crc32c';

/**
 * Bilinen test vektörleri (RFC 3720 / iSCSI ve yaygın CRC32C referansları).
 * Yanlış bir tablo, KMS'in checksum'ı reddetmesine ve her kimlik doğrulamasının
 * düşmesine yol açardı — bu yüzden vektörle sabitlenir.
 */
describe('crc32c', () => {
  it('boş girdi için 0 üretir', () => {
    expect(crc32c(Buffer.alloc(0))).toBe(0);
  });

  it('"123456789" için 0xE3069283 üretir', () => {
    expect(crc32c(Buffer.from('123456789', 'utf8'))).toBe(0xe3069283);
  });

  it('32 sıfır bayt için 0x8A9136AA üretir', () => {
    expect(crc32c(Buffer.alloc(32, 0))).toBe(0x8a9136aa);
  });

  it('32 adet 0xFF için 0x62A8AB43 üretir', () => {
    expect(crc32c(Buffer.alloc(32, 0xff))).toBe(0x62a8ab43);
  });

  it('farklı girdi farklı değer üretir', () => {
    expect(crc32c(Buffer.from('12345678901'))).not.toBe(crc32c(Buffer.from('12345678902')));
  });
});
