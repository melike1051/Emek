import type { ProviderState } from '@emek/api-client';
import type { BadgeTone } from '@emek/ui';

/** Sağlayıcı başvuru durumu → kullanıcıya gösterilen metin (provider-transitions.ts ile aynı küme). */
export const PROVIDER_STATE_VIEW: Record<
  ProviderState,
  { label: string; tone: BadgeTone; next: string }
> = {
  DRAFT: {
    label: 'Taslak',
    tone: 'neutral',
    next: 'Hizmetlerinizi, bölgenizi ve müsaitliğinizi ekleyip başvurunuzu incelemeye gönderin.',
  },
  PENDING_REVIEW: {
    label: 'İncelemede',
    tone: 'highlight',
    next: 'Başvurunuz ekibimiz tarafından inceleniyor. Sonuç size bildirilecek.',
  },
  APPROVED: {
    label: 'Onaylandı',
    tone: 'trust',
    next: 'Profiliniz yayında; uygun taleplerde eşleştirmeye dahil ediliyorsunuz.',
  },
  REJECTED: {
    label: 'Reddedildi',
    tone: 'danger',
    next: 'Başvurunuz onaylanmadı. Bilgilerinizi güncelleyip yeniden başvurabilirsiniz.',
  },
  SUSPENDED: {
    label: 'Askıda',
    tone: 'danger',
    next: 'Profiliniz geçici olarak askıya alındı. Destek ekibiyle iletişime geçin.',
  },
};
