import { TEMPLATE_KEYS_BY_CHANNEL } from '../common/events/consumers/notification-job.consumer';
import {
  EMAIL_TEMPLATE_KEYS,
  SMS_TEMPLATE_KEYS,
  renderEmail,
  renderSms,
} from './message-templates';
import { classifyFcm } from './push-sender';
import { renderPush } from './push-templates';

describe('classifyFcm (FCM HTTP v1 hata sınıflandırması)', () => {
  it.each([
    [200, undefined, 'SENT'],
    [404, 'UNREGISTERED', 'INVALID_TOKEN'],
    [404, undefined, 'INVALID_TOKEN'],
    [400, 'INVALID_ARGUMENT', 'PERMANENT'],
    [429, 'QUOTA_EXCEEDED', 'TRANSIENT'],
    [503, 'UNAVAILABLE', 'TRANSIENT'],
    [500, 'INTERNAL', 'TRANSIENT'],
    [403, 'SENDER_ID_MISMATCH', 'PERMANENT'],
    [401, 'THIRD_PARTY_AUTH_ERROR', 'PERMANENT'],
  ] as const)('%s %s → %s', (status, code, expected) => {
    expect(classifyFcm(status, code)).toBe(expected);
  });
});

describe('renderPush', () => {
  const bookingId = '0b9d8c1e-1111-4222-8333-444455556666';

  it('rota alıcının tarafına göre: müşteri randevuları / sağlayıcı paneli', () => {
    expect(renderPush('booking.cancelled', { bookingId, audience: 'CUSTOMER' })?.route).toBe(
      `/randevular/${bookingId}`,
    );
    expect(renderPush('booking.cancelled', { bookingId, audience: 'PROVIDER' })?.route).toBe(
      `/panel/randevular/${bookingId}`,
    );
  });

  it('metin PII taşımaz: şablon verisindeki alanlar metne girmez', () => {
    const content = renderPush('payment.refunded', {
      bookingId,
      audience: 'CUSTOMER',
      amountMinor: '96000',
      displayName: 'Ayşe K.',
    });
    expect(`${content?.title} ${content?.body}`).not.toMatch(/960|Ayşe|0b9d8c1e/);
  });

  it('bilinmeyen şablon null', () => {
    expect(renderPush('something.new', {})).toBeNull();
  });

  it('bozuk ya da eksik randevu kimliği rota üretmez', () => {
    expect(
      renderPush('booking.cancelled', { bookingId: '../ayarlar', audience: 'CUSTOMER' }),
    ).toBeNull();
    expect(renderPush('booking.cancelled', { audience: 'CUSTOMER' })).toBeNull();
  });
});

describe('SMS / e-posta şablonları (R-77)', () => {
  it('consumer bir kanala iş üretiyorsa o kanalın metni vardır (UNRENDERABLE olmaz)', () => {
    for (const key of TEMPLATE_KEYS_BY_CHANNEL.SMS) expect(renderSms(key)).not.toBeNull();
    for (const key of TEMPLATE_KEYS_BY_CHANNEL.EMAIL) expect(renderEmail(key)).not.toBeNull();
    expect([...SMS_TEMPLATE_KEYS].sort()).toEqual([...TEMPLATE_KEYS_BY_CHANNEL.SMS].sort());
    expect([...EMAIL_TEMPLATE_KEYS].sort()).toEqual([...TEMPLATE_KEYS_BY_CHANNEL.EMAIL].sort());
  });

  it('SMS kısa kalır (≤ 160 karakter); şablonu olmayan kanal null döner', () => {
    for (const key of SMS_TEMPLATE_KEYS)
      expect(renderSms(key)!.text.length).toBeLessThanOrEqual(160);
    expect(renderSms('booking.confirmed')).toBeNull();
    expect(renderEmail('booking.cancelled')).toBeNull();
  });
});
