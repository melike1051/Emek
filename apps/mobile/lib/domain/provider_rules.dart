/// Sağlayıcı alanının saf kuralları — `apps/web/src/lib/provider.ts` ile **aynı** davranış.
/// Backend transition map'inin (ADR-0006) aynasıdır, yetki kaynağı değildir.
library;

import 'booking_rules.dart';

/// Sağlayıcı diliyle durum etiketleri — müşteri etiketleri karşı tarafın bakışıdır
/// ("Sağlayıcı onayı bekleniyor") ve sağlayıcıya yanlış şeyi söylerdi.
const _providerStatus = <String, StatusView>{
  'REQUESTED': StatusView('Talep alındı', Tone.neutral),
  'MATCHED': StatusView('Eşleşti', Tone.neutral),
  'PROVIDER_PENDING': StatusView('Yanıtınız bekleniyor', Tone.highlight),
  'CONFIRMED': StatusView('Müşteri ödemesi bekleniyor', Tone.neutral),
  'PAYMENT_AUTHORIZED': StatusView('Ödeme güvende', Tone.trust),
  'SCHEDULED': StatusView('Planlandı', Tone.trust),
  'PROVIDER_ARRIVING': StatusView('Yoldasınız', Tone.trust),
  'CHECKED_IN': StatusView('Adrestesiniz', Tone.trust),
  'IN_PROGRESS': StatusView('Hizmet sürüyor', Tone.trust),
  'CHECKED_OUT': StatusView('Müşteri onayı bekleniyor', Tone.highlight),
  'CUSTOMER_CONFIRMED': StatusView('Müşteri onayladı', Tone.trust),
  'COMPLETED': StatusView('Tamamlandı', Tone.trust),
  'SETTLED': StatusView('Ödeme aktarıldı', Tone.neutral),
  'CANCELLED': StatusView('İptal edildi', Tone.neutral),
  'DISPUTED': StatusView('İtiraz inceleniyor', Tone.danger),
  'SAFETY_HOLD': StatusView('Güvenlik incelemesi', Tone.danger),
};

StatusView providerBookingStatusView(String status) =>
    _providerStatus[status] ?? StatusView(status, Tone.neutral);

/// Hizmet günü akışında sağlayıcının bir sonraki adımı (transition map'teki PROVIDER geçişleri).
class NextStep {
  const NextStep(this.to, this.label, this.confirmLabel, this.hint);
  final String to;
  final String label;
  final String confirmLabel;
  final String hint;
}

const _nextStep = <String, NextStep>{
  'SCHEDULED': NextStep(
    'PROVIDER_ARRIVING',
    'Yola çıktım',
    'Evet, yola çıkıyorum',
    'Yola çıktığınızda güvenlik oturumu başlar; müşteri sizin yolda olduğunuzu görür.',
  ),
  'PROVIDER_ARRIVING': NextStep(
    'CHECKED_IN',
    'Adrese vardım',
    'Evet, adresteyim',
    'Vardığınızda başlamadan önce “önce” fotoğrafını ekleyin.',
  ),
  'CHECKED_IN': NextStep(
    'IN_PROGRESS',
    'Hizmeti başlat',
    'Evet, başlıyorum',
    'Başlamadan önce “önce” fotoğrafı eklemeniz, olası bir itirazda sizi korur.',
  ),
  'IN_PROGRESS': NextStep(
    'CHECKED_OUT',
    'Hizmeti bitirdim',
    'Evet, hizmet bitti',
    'Bitirmeden önce “sonra” fotoğrafını ekleyin. Ardından müşterinin onayı beklenir.',
  ),
};

const _cancellableByProvider = {
  'CONFIRMED',
  'PAYMENT_AUTHORIZED',
  'SCHEDULED',
  'PROVIDER_ARRIVING',
};
const _safetyVisible = {
  'SCHEDULED',
  'PROVIDER_ARRIVING',
  'CHECKED_IN',
  'IN_PROGRESS',
  'CHECKED_OUT',
  'SAFETY_HOLD',
};

/// Hizmet adresi görünürlüğü (R-102) — backend `PROVIDER_ADDRESS_STATUSES` aynası.
enum AddressVisibility { visible, afterPayment, closed }

const _addressVisible = {
  'SCHEDULED',
  'PROVIDER_ARRIVING',
  'CHECKED_IN',
  'IN_PROGRESS',
  'CHECKED_OUT',
};
const _addressPending = {
  'REQUESTED',
  'MATCHED',
  'PROVIDER_PENDING',
  'CONFIRMED',
  'PAYMENT_AUTHORIZED',
};

/// Kanıt türlerinin sağlayıcı ve müşteri için ortak adları.
const documentTypeLabels = <String, String>{
  'BEFORE_PHOTO': 'Önce',
  'AFTER_PHOTO': 'Sonra',
  'SERVICE_NOTE': 'Hizmet notu',
  'DISPUTE_EVIDENCE': 'İtiraz kanıtı',
  'INVOICE': 'Fatura',
};

class ProviderActions {
  const ProviderActions._({
    required this.canRespond,
    required this.canCancel,
    required this.next,
    required this.uploadable,
    required this.hasSafetySession,
    required this.address,
  });

  factory ProviderActions.of(String status) => ProviderActions._(
    // Ret = `PROVIDER_PENDING → CANCELLED` (ayrı "reddet" ucu yoktur).
    canRespond: status == 'PROVIDER_PENDING',
    canCancel: _cancellableByProvider.contains(status),
    next: _nextStep[status],
    uploadable: [
      if (status == 'CHECKED_IN' || status == 'IN_PROGRESS') 'BEFORE_PHOTO',
      if (status == 'IN_PROGRESS' || status == 'CHECKED_OUT') 'AFTER_PHOTO',
    ],
    hasSafetySession: _safetyVisible.contains(status),
    address: _addressVisible.contains(status)
        ? AddressVisibility.visible
        : _addressPending.contains(status)
        ? AddressVisibility.afterPayment
        : AddressVisibility.closed,
  );

  final bool canRespond;
  final bool canCancel;
  final NextStep? next;

  /// Bu durumda eklenebilecek kanıt türleri (backend türü duruma bağlamaz; akış bağlar).
  final List<String> uploadable;
  final bool hasSafetySession;
  final AddressVisibility address;
}

class ReadinessItem {
  const ReadinessItem(this.key, this.label, this.done, this.route);
  final String key;
  final String label;
  final bool done;

  /// Eksikse gidilecek ekran; kimlik doğrulaması şimdilik salt okunur (adım 5).
  final String? route;
}

/// Eşleştirmeye girmek için gerekenler (Faz 7 hard constraint'leri). Backend başvuruyu bunlara
/// bağlamaz — liste yol göstericidir. Kimlik eşleştirmeyi bloklar, başvuruyu değil.
List<ReadinessItem> readiness({
  required String? bio,
  required bool hasActiveService,
  required bool hasActiveArea,
  required int upcomingAvailability,
  required bool identityVerified,
}) => [
  ReadinessItem(
    'profile',
    'Kendinizi tanıtın',
    (bio ?? '').trim().isNotEmpty,
    '/panel/profil',
  ),
  ReadinessItem(
    'services',
    'Sunduğunuz hizmetleri seçin',
    hasActiveService,
    '/panel/hizmetler',
  ),
  ReadinessItem(
    'areas',
    'Hizmet bölgenizi ekleyin',
    hasActiveArea,
    '/panel/bolgeler',
  ),
  ReadinessItem(
    'availability',
    'Müsait olduğunuz saatleri girin',
    upcomingAvailability > 0,
    '/panel/musaitlik',
  ),
  ReadinessItem('identity', 'Kimliğinizi doğrulayın', identityVerified, null),
];

/// Başvuru gönderilebilir mi: kimlik dışındaki tüm maddeler tamam.
bool canSubmitApplication(List<ReadinessItem> items) =>
    items.where((item) => item.key != 'identity').every((item) => item.done);

const radiusOptionsKm = [1, 3, 5, 10, 20, 50];

String formatRadius(int meters) => meters >= 1000
    ? '${(meters / 1000).toStringAsFixed(meters % 1000 == 0 ? 0 : 1).replaceAll('.', ',')} km'
    : '$meters m';

// --- Zaman: hizmet saatleri İstanbul saatiyle girilir ve gösterilir ---

/// İstanbul takvim günü (yıl/ay/gün, saat yok) — `DateTime.utc` ile temsil edilir.
DateTime istanbulDay(DateTime instant) {
  final local = toIstanbul(instant);
  return DateTime.utc(local.year, local.month, local.day);
}

/// İstanbul günü + saat → UTC an.
DateTime istanbulAt(DateTime day, int hour, int minute) => DateTime.utc(
  day.year,
  day.month,
  day.day,
  hour,
  minute,
).subtract(istanbulOffset);

/// Haftanın pazartesisi (İstanbul) — müsaitlik haftalık görüntülenir.
DateTime weekStart(DateTime day) =>
    day.subtract(Duration(days: day.weekday - DateTime.monday));

const _weekdays = [
  'Pazartesi',
  'Salı',
  'Çarşamba',
  'Perşembe',
  'Cuma',
  'Cumartesi',
  'Pazar',
];

String dayTitle(DateTime day) =>
    '${_weekdays[day.weekday - 1]}, ${formatCalendarDay(day)}';
