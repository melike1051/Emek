/// Randevu alanının saf kuralları — `apps/web/src/lib/booking.ts` ve `request-form.ts` ile
/// **aynı** davranış. Backend transition map'inin (ADR-0006) aynasıdır, yetki kaynağı değildir:
/// backend her komutu ayrıca doğrular ve reddi ekranda gösterilir.
library;

enum Tone { neutral, highlight, trust, danger }

/// Türkçe büyük harf: Dart `toUpperCase` dile duyarsızdır ('i' → 'I'). Web bunu CSS
/// `text-transform` + `lang="tr"` ile doğru yapar; burada açıkça eşlenir.
String trUpper(String text) =>
    text.replaceAll('i', 'İ').replaceAll('ı', 'I').toUpperCase();

class StatusView {
  const StatusView(this.label, this.tone);
  final String label;
  final Tone tone;
}

/// Müşteri diliyle durum etiketleri; teknik ad kullanıcıya gösterilmez.
const _bookingStatus = <String, StatusView>{
  'REQUESTED': StatusView('Talep alındı', Tone.neutral),
  'MATCHED': StatusView('Eşleşti', Tone.neutral),
  'PROVIDER_PENDING': StatusView('Sağlayıcı onayı bekleniyor', Tone.highlight),
  'CONFIRMED': StatusView('Onaylandı — ödeme bekleniyor', Tone.highlight),
  'PAYMENT_AUTHORIZED': StatusView('Ödeme alındı', Tone.trust),
  'SCHEDULED': StatusView('Planlandı', Tone.trust),
  'PROVIDER_ARRIVING': StatusView('Sağlayıcı yolda', Tone.trust),
  'CHECKED_IN': StatusView('Sağlayıcı geldi', Tone.trust),
  'IN_PROGRESS': StatusView('Hizmet sürüyor', Tone.trust),
  'CHECKED_OUT': StatusView('Onayınız bekleniyor', Tone.highlight),
  'CUSTOMER_CONFIRMED': StatusView('Onayladınız', Tone.trust),
  'COMPLETED': StatusView('Tamamlandı', Tone.trust),
  'SETTLED': StatusView('Kapandı', Tone.neutral),
  'CANCELLED': StatusView('İptal edildi', Tone.neutral),
  'DISPUTED': StatusView('İtiraz inceleniyor', Tone.danger),
  'SAFETY_HOLD': StatusView('Güvenlik incelemesi', Tone.danger),
};

StatusView bookingStatusView(String status) =>
    _bookingStatus[status] ?? StatusView(status, Tone.neutral);

const _paymentStatus = <String, StatusView>{
  'CREATED': StatusView('Başlatıldı', Tone.neutral),
  'AUTHORIZED': StatusView('Yetkilendirildi', Tone.trust),
  'HELD': StatusView('Güvende tutuluyor', Tone.trust),
  'SERVICE_COMPLETED': StatusView('Hizmet tamamlandı', Tone.trust),
  'RELEASE_PENDING': StatusView('Aktarım bekleniyor', Tone.neutral),
  'RELEASED': StatusView('Sağlayıcıya aktarıldı', Tone.neutral),
  'FAILED': StatusView('Başarısız', Tone.danger),
  'REFUNDED': StatusView('İade edildi', Tone.neutral),
  'DISPUTED': StatusView('İtiraz nedeniyle bekletiliyor', Tone.danger),
  'AUTHORIZATION_EXPIRED': StatusView('Yetki süresi doldu', Tone.danger),
};

StatusView paymentStatusView(String status) =>
    _paymentStatus[status] ?? StatusView(status, Tone.neutral);

const disputeReasonLabels = <String, String>{
  'SERVICE_NOT_PERFORMED': 'Hizmet verilmedi',
  'SERVICE_QUALITY': 'Hizmet kalitesi',
  'DAMAGE': 'Hasar',
  'BILLING': 'Ücretlendirme',
  'SAFETY': 'Güvenlik',
  'OTHER': 'Diğer',
};

const disputeStatusLabels = <String, String>{
  'OPEN': 'Açık',
  'UNDER_REVIEW': 'İnceleniyor',
  'RESOLVED_CUSTOMER': 'Lehinize sonuçlandı',
  'RESOLVED_PROVIDER': 'Sağlayıcı lehine sonuçlandı',
  'WITHDRAWN': 'Geri çekildi',
};

/// Geçmiş sekmesine düşen, akışı bitmiş durumlar.
const _terminal = {'COMPLETED', 'SETTLED', 'CANCELLED'};
bool isActiveBooking(String status) => !_terminal.contains(status);

const _cancellableByParty = {
  'REQUESTED',
  'MATCHED',
  'PROVIDER_PENDING',
  'CONFIRMED',
  'PAYMENT_AUTHORIZED',
  'SCHEDULED',
  'PROVIDER_ARRIVING',
};
const _disputable = {'CHECKED_OUT', 'CUSTOMER_CONFIRMED', 'COMPLETED'};
const _safetyVisible = {
  'SCHEDULED',
  'PROVIDER_ARRIVING',
  'CHECKED_IN',
  'IN_PROGRESS',
  'CHECKED_OUT',
  'SAFETY_HOLD',
};

class CustomerActions {
  const CustomerActions._({
    required this.canPay,
    required this.canCancel,
    required this.canConfirmService,
    required this.canReview,
    required this.canDispute,
    required this.hasSafetySession,
  });

  factory CustomerActions.of(String status) => CustomerActions._(
    canPay: status == 'CONFIRMED',
    canCancel: _cancellableByParty.contains(status),
    canConfirmService: status == 'CHECKED_OUT',
    canReview: status == 'COMPLETED' || status == 'SETTLED',
    canDispute: _disputable.contains(status),
    hasSafetySession: _safetyVisible.contains(status),
  );

  final bool canPay;
  final bool canCancel;
  final bool canConfirmService;
  final bool canReview;
  final bool canDispute;

  /// Güvenlik oturumu ekranı anlamlı mı (hizmet günü akışı).
  final bool hasSafetySession;
}

/// Para minor unit **string** olarak gelir (BIGINT); `int`'e sığmayabilir — `BigInt` ile
/// biçimlendirilir (Faz 5 review bulgusu M2). `96000` + `TRY` → `960,00 ₺`.
String formatMoney(String minor, String currency) {
  if (!RegExp(r'^-?\d+$').hasMatch(minor)) return '$minor $currency';
  final negative = minor.startsWith('-');
  final digits = (negative ? minor.substring(1) : minor).padLeft(3, '0');
  final whole = BigInt.parse(digits.substring(0, digits.length - 2)).toString();
  final fraction = digits.substring(digits.length - 2);
  final grouped = whole.replaceAllMapped(
    RegExp(r'\B(?=(\d{3})+(?!\d))'),
    (_) => '.',
  );
  final symbol = currency == 'TRY' ? '₺' : currency;
  return '${negative ? '-' : ''}$grouped,$fraction $symbol';
}

/// Türkiye 2016'dan beri sabit UTC+3 (yaz saati yok); saatler cihazın diliminden bağımsız
/// İstanbul saati gösterilir/girilir.
const istanbulOffset = Duration(hours: 3);

const _months = [
  'Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', //
  'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara',
];

DateTime toIstanbul(DateTime instant) => instant.toUtc().add(istanbulOffset);

String _two(int value) => value.toString().padLeft(2, '0');

String formatTime(DateTime instant) {
  final local = toIstanbul(instant);
  return '${_two(local.hour)}:${_two(local.minute)}';
}

String formatDate(DateTime instant) {
  final local = toIstanbul(instant);
  return '${local.day} ${_months[local.month - 1]} ${local.year}';
}

/// Takvim günü (saat dilimi dönüşümü yok): seçicinin verdiği gün olduğu gibi yazılır.
String formatCalendarDay(DateTime day) =>
    '${day.day} ${_months[day.month - 1]} ${day.year}';

String formatDateTime(DateTime instant) =>
    '${formatDate(instant)} ${formatTime(instant)}';

/// Aynı gün içindeki aralık tek tarihle yazılır: "12 Eki 2026 10:00 – 12:00".
String formatRange(DateTime start, DateTime end) =>
    formatDate(start) == formatDate(end)
    ? '${formatDateTime(start)} – ${formatTime(end)}'
    : '${formatDateTime(start)} – ${formatDateTime(end)}';

/// Eşleştirme açıklaması kapalı kod kümesidir; metni istemci üretir (ADR-0007 §6).
/// Bilinmeyen kod (yeni motor sürümü) `null` → sessizce atlanır.
String? explanationText(String code, num? value) => switch (code) {
  'ALL_REQUIRED_SKILLS_VERIFIED' => 'Gerekli tüm becerileri doğrulanmış',
  'EXPERT_LEVEL_SKILLS' => 'Bu işte uzman seviyesinde',
  'PREFERRED_SKILLS_MATCHED' => 'Tercih ettiğiniz becerilere sahip',
  'PREFERRED_SKILLS_PARTIAL' =>
    'Tercih ettiğiniz becerilerin bir kısmına sahip',
  'FULL_WINDOW_AVAILABLE' => 'İstediğiniz zaman aralığının tamamında müsait',
  'PARTIAL_WINDOW_AVAILABLE' => 'İstediğiniz aralığın bir bölümünde müsait',
  'NEARBY' =>
    value != null ? 'Yaklaşık ${value.round()} km uzaklıkta' : 'Size yakın',
  'WITHIN_SERVICE_AREA' => 'Hizmet bölgesi adresinizi kapsıyor',
  'HIGH_RATING' =>
    value != null
        ? 'Yüksek puanlı (${value.toStringAsFixed(1).replaceAll('.', ',')}/5)'
        : 'Yüksek puanlı',
  'LIMITED_RATING_HISTORY' => 'Henüz az değerlendirmesi var',
  'EXPERIENCED' => 'Deneyimli',
  _ => null,
};

/// Backend eşiği 0,6'dır (altı zaten talep oluşturmaz); bu eşik yalnız **tavsiye**dir.
const reviewConfidenceAdvisory = 0.8;
bool needsReview(double? confidence) =>
    confidence != null && confidence < reviewConfidenceAdvisory;

sealed class WindowResult {
  const WindowResult();
}

class WindowOk extends WindowResult {
  const WindowOk(this.start, this.end);
  final DateTime start;
  final DateTime end;
}

class WindowError extends WindowResult {
  const WindowError(this.message);
  final String message;
}

/// Form yolu: İstanbul saatiyle gün + aralık → UTC anlar (web `buildWindow` ile aynı kurallar).
WindowResult buildWindow({
  required DateTime? date,
  required ({int hour, int minute})? from,
  required ({int hour, int minute})? to,
  required int durationMinutes,
  DateTime? now,
}) {
  if (date == null || from == null || to == null) {
    return const WindowError('Tarih ve saat aralığını seçin.');
  }
  if (durationMinutes < 30 || durationMinutes > 1440) {
    return const WindowError('Süre 30 dakika ile 24 saat arasında olmalı.');
  }
  DateTime at(({int hour, int minute}) time) => DateTime.utc(
    date.year,
    date.month,
    date.day,
    time.hour,
    time.minute,
  ).subtract(istanbulOffset);
  final start = at(from);
  final end = at(to);
  if (!end.isAfter(start)) {
    return const WindowError('Bitiş saati başlangıçtan sonra olmalı.');
  }
  if (!start.isAfter(now ?? DateTime.now())) {
    return const WindowError('Geçmiş bir zaman seçilemez.');
  }
  if (end.difference(start).inMinutes < durationMinutes) {
    return const WindowError('Zaman aralığı hizmet süresinden kısa olamaz.');
  }
  return WindowOk(start, end);
}
