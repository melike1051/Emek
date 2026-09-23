import type { Request } from 'express';
import { resolveClientIp } from './client-ip';

function req(socket: string, xff?: string | string[]): Request {
  return {
    socket: { remoteAddress: socket },
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  } as unknown as Request;
}

describe('resolveClientIp (R-53)', () => {
  it('hopCount=0 iken X-Forwarded-For tamamen yok sayılır', () => {
    expect(resolveClientIp(req('10.0.0.1', '1.2.3.4'), 0)).toBe('10.0.0.1');
  });

  it('hopCount=1 iken en sağdaki forwarded girdisi alınır', () => {
    expect(resolveClientIp(req('10.0.0.1', '9.9.9.9, 8.8.8.8'), 1)).toBe('8.8.8.8');
  });

  // Cloud Run topolojisi: "istemci, google-lb" → hopCount=2 gerçek istemciyi verir.
  it('hopCount=2 iken Cloud Run zincirinde gerçek istemci adresi bulunur', () => {
    expect(resolveClientIp(req('169.254.1.1', '203.0.113.7, 35.191.0.1'), 2)).toBe('203.0.113.7');
  });

  // Saldırgan zincirin soluna istediği kadar sahte adres yazabilir; sağdan sayıldığı
  // için bu girdiler seçime hiç giremez ve sayaç anahtarı değişmez.
  it('sahte başlık öneki sayaç anahtarını değiştiremez', () => {
    const spoofed = resolveClientIp(
      req('169.254.1.1', 'evil-1, evil-2, evil-3, 203.0.113.7, 35.191.0.1'),
      2,
    );
    expect(spoofed).toBe('203.0.113.7');
  });

  it('her istekte farklı sahte önek verilse bile aynı kovaya düşer', () => {
    const first = resolveClientIp(req('169.254.1.1', '1.1.1.1, 203.0.113.7, 35.191.0.1'), 2);
    const second = resolveClientIp(req('169.254.1.1', '2.2.2.2, 203.0.113.7, 35.191.0.1'), 2);
    expect(first).toBe(second);
  });

  // Zincir beklenenden kısaysa kalan girdiler istemci yazımı olabilir: fail-closed.
  it('zincir beklenenden kısaysa soket adresine düşer', () => {
    expect(resolveClientIp(req('10.0.0.1', '203.0.113.7'), 2)).toBe('10.0.0.1');
    expect(resolveClientIp(req('10.0.0.1'), 2)).toBe('10.0.0.1');
  });

  it('başlık yokken soket adresi kullanılır', () => {
    expect(resolveClientIp(req('10.0.0.1'), 1)).toBe('10.0.0.1');
  });

  it('IPv4-mapped IPv6 adresi IPv4 ile aynı kovaya düşer', () => {
    expect(resolveClientIp(req('::ffff:10.0.0.1'), 0)).toBe('10.0.0.1');
  });

  it('başlık dizi olarak geldiğinde birleştirilir', () => {
    expect(resolveClientIp(req('10.0.0.1', ['203.0.113.7', '35.191.0.1']), 2)).toBe('203.0.113.7');
  });

  it('soket adresi bilinmiyorsa anahtar yine de üretilir', () => {
    const request = { socket: {}, headers: {} } as unknown as Request;
    expect(resolveClientIp(request, 0)).toBe('unknown');
  });
});
