/**
 * SMS ve e-posta metinleri (Türkçe, tek dil; R-77). Push şablonları gibi **PII içermez**: ad,
 * adres, tutar, randevu kimliği yok — SMS kilit ekranında, e-posta üçüncü taraf sunucularda
 * görünür. Ayrıntı uygulamada, oturum açıkken okunur.
 *
 * Kanal politikası (hangi olay hangi kanala) `notification-job.consumer.ts`'dedir; burada
 * olmayan şablonun o kanala işi `UNRENDERABLE` ile başarısız olur.
 */
export interface SmsContent {
  text: string;
}

export interface EmailContent {
  subject: string;
  text: string;
}

const SMS: Record<string, string> = {
  'booking.new_request': 'Emek: Size uygun yeni bir randevu talebi var. Uygulamadan yanıtlayın.',
  'booking.cancelled': 'Emek: Bir randevunuz iptal edildi. Ayrıntılar uygulamada.',
};

const EMAIL: Record<string, EmailContent> = {
  'payment.released': {
    subject: 'Ödemeniz aktarıldı',
    text: 'Bir hizmetin ödemesi hesabınıza aktarıldı. Ayrıntıları Emek uygulamasında görebilirsiniz.',
  },
  'payment.refunded': {
    subject: 'İade yapıldı',
    text: 'Bir ödemeniz iade edildi. Ayrıntıları Emek uygulamasında görebilirsiniz.',
  },
  'dispute.resolved': {
    subject: 'İtiraz sonuçlandı',
    text: 'Bir itirazın sonucu açıklandı. Ayrıntıları Emek uygulamasında görebilirsiniz.',
  },
};

const FOOTER = '\n\nBu ileti, Emek hesabınızdaki bir işlem hakkında bilgilendirme amaçlıdır.';

export const SMS_TEMPLATE_KEYS: readonly string[] = Object.keys(SMS);
export const EMAIL_TEMPLATE_KEYS: readonly string[] = Object.keys(EMAIL);

/** `null`: bu şablonun SMS metni yok. */
export function renderSms(templateKey: string): SmsContent | null {
  const text = SMS[templateKey];
  return text === undefined ? null : { text };
}

/** `null`: bu şablonun e-posta metni yok. */
export function renderEmail(templateKey: string): EmailContent | null {
  const content = EMAIL[templateKey];
  return content === undefined ? null : { subject: content.subject, text: content.text + FOOTER };
}
