/**
 * Push metinleri (Türkçe, tek dil). Bilinçli olarak **PII içermez**: ad, adres, tutar ya da hizmet
 * ayrıntısı kilit ekranında görünmemeli. Ayrıntı uygulamada, oturum açıkken okunur; bildirim
 * yalnız "bak" der ve `data` ile ilgili ekranın yolunu taşır.
 */
export interface PushContent {
  title: string;
  body: string;
  /** İstemcinin açacağı ekran (uygulama içi yol). */
  route: string;
}

type TemplateData = Record<string, unknown>;

const bookingId = (data: TemplateData) =>
  typeof data['bookingId'] === 'string' ? data['bookingId'] : '';

/** Alıcının tarafına göre ekran: sağlayıcı paneli ya da müşteri randevuları (mobil rotalar). */
const bookingRoute = (data: TemplateData) =>
  data['audience'] === 'PROVIDER'
    ? `/panel/randevular/${bookingId(data)}`
    : `/randevular/${bookingId(data)}`;

const TEMPLATES: Record<string, (data: TemplateData) => PushContent> = {
  'booking.new_request': (d) => ({
    title: 'Yeni randevu talebi',
    body: 'Size uygun bir talep var. Yanıtınız bekleniyor.',
    route: bookingRoute(d),
  }),
  'booking.confirmed': (d) => ({
    title: 'Randevunuz onaylandı',
    body: 'Sağlayıcı randevunuzu kabul etti. Ödemeyi onaylayarak planlayın.',
    route: bookingRoute(d),
  }),
  'booking.cancelled': (d) => ({
    title: 'Randevu iptal edildi',
    body: 'Bir randevunuz iptal edildi. Ayrıntılar uygulamada.',
    route: bookingRoute(d),
  }),
  'service.started': (d) => ({
    title: 'Hizmet başladı',
    body: 'Sağlayıcı hizmete başladı.',
    route: bookingRoute(d),
  }),
  'service.completed': (d) => ({
    title: 'Hizmet tamamlandı',
    body: 'Deneyiminizi değerlendirmek ister misiniz?',
    route: bookingRoute(d),
  }),
  'payment.authorized': (d) => ({
    title: 'Ödeme güvende',
    body: 'Müşteri ödemeyi onayladı; randevu planlandı.',
    route: bookingRoute(d),
  }),
  'payment.released': (d) => ({
    title: 'Ödemeniz aktarıldı',
    body: 'Bir hizmetin ödemesi hesabınıza aktarıldı.',
    route: bookingRoute(d),
  }),
  'payment.refunded': (d) => ({
    title: 'İade yapıldı',
    body: 'Bir ödemeniz iade edildi.',
    route: bookingRoute(d),
  }),
  'dispute.resolved': (d) => ({
    title: 'İtiraz sonuçlandı',
    body: 'Bir itirazın sonucu açıklandı.',
    route: bookingRoute(d),
  }),
};

/**
 * Durum-duyarlı şablonlar (R-114): bildirim yalnız randevu hâlâ bu durumlardan birindeyse gider.
 * Geri çekilmedeki bir "yanıtınız bekleniyor" push'u, randevu bu arada iptal edildiyse ya da
 * ilerlediyse artık yanlış eylem ister. Listede olmayan şablon (iptal, tamamlandı, ödeme …)
 * geçmiş bir olayı bildirir; sonradan gelen durum onu geçersiz kılmaz. Alıcı kontrol edilmez:
 * randevu aynı durumda başka sağlayıcıya yeniden eşlenirse eski sağlayıcı bildirimi alabilir —
 * ekran güncel durumu sunucudan okur, yanlış eylem mümkün değildir (erişim kontrolü).
 */
export const RELEVANT_BOOKING_STATUSES: Readonly<Record<string, readonly string[]>> = {
  'booking.new_request': ['MATCHED', 'PROVIDER_PENDING'],
  'booking.confirmed': ['CONFIRMED'],
};

/** Bilinmeyen şablon `null`: iş kalıcı olarak başarısız sayılır (kod yeni şablonu bilmiyor). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `null`: şablon bilinmiyor ya da kimlik bozuk. Rota istemciye gider; consumer kimliği zaten
 * doğrular ama operatörün yeniden kuyrukladığı satır da buradan geçer — bozuk yol üretilmez.
 */
export function renderPush(templateKey: string, data: TemplateData): PushContent | null {
  const render = TEMPLATES[templateKey];
  if (render === undefined || !UUID.test(bookingId(data))) return null;
  return render(data);
}
