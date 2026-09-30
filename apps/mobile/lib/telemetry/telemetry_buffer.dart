/// Hizmet oturumu telemetrisinin saf çekirdeği (ADR-0025 §8, ADR-0008). Platformdan ve ağdan
/// bağımsızdır; birim testlidir.
///
/// Backend sözleşmesi (services/api/src/safety):
/// - oturum içinde **kesin artan** `sequence` ≥ 1; sunucunun gördüğü her numara tüketilir
///   (reddedilen de) — aynı numara tekrar gönderilirse `SEQUENCE_REPLAY`;
/// - örnekler arası ≥ 5 sn (`TOO_FREQUENT`), 900 sn'den eski örnek reddedilir (`CLOCK_SKEW_STALE`);
/// - parti ≤ 20 örnek; kullanıcı başına dakikada ≤ 60 istek.
/// Telemetri **güvenilmez istemci girdisidir**: sunucu zamanı yetkilidir; istemci yalnız
/// ölçtüğünü dürüstçe bildirir (sahte konum işareti dahil), yargıyı sunucu verir.
library;

/// Backend `MAX_SAMPLES_PER_BATCH`.
const maxSamplesPerBatch = 20;

/// Backend `TELEMETRY_MIN_SPACING_SECONDS`.
const minSpacing = Duration(seconds: 5);

/// Backend `SAFETY_TELEMETRY_MAX_AGE_SECONDS` varsayılanı; daha eskisi zaten reddedilir, tutulmaz.
const maxSampleAge = Duration(seconds: 900);

/// Platformdan gelen ham konum okuması.
class LocationReading {
  const LocationReading({
    required this.capturedAt,
    required this.latitude,
    required this.longitude,
    required this.accuracyMeters,
    this.speedMps,
    this.headingDegrees,
    this.isMock = false,
  });

  final DateTime capturedAt;
  final double latitude;
  final double longitude;
  final double accuracyMeters;

  /// Platformlar bilinmeyen hızı/yönü negatif bildirir; bu durumda `null`.
  final double? speedMps;
  final double? headingDegrees;
  final bool isMock;
}

class TelemetrySample {
  const TelemetrySample(this.sequence, this.reading);
  final int sequence;
  final LocationReading reading;

  /// Kaynak: TelemetrySampleDto. Sınır dışı isteğe bağlı alanlar gönderilmez (backend DTO
  /// doğrulaması tüm partiyi reddederdi).
  Map<String, Object> toJson() {
    final r = reading;
    final speed = r.speedMps;
    final heading = r.headingDegrees;
    return {
      'sequence': sequence,
      'capturedAt': r.capturedAt.toUtc().toIso8601String(),
      'latitude': r.latitude,
      'longitude': r.longitude,
      'accuracyMeters': r.accuracyMeters.clamp(0, 100000),
      if (speed != null && speed >= 0 && speed <= 400) 'speedMps': speed,
      if (heading != null && heading >= 0 && heading < 360)
        'headingDegrees': heading,
      'isMockLocation': r.isMock,
    };
  }
}

/// Sıra numarası atar, aralığı uygular, gönderilmeyi bekleyenleri tutar.
class TelemetryBuffer {
  /// [lastSequence]: sunucunun oturum görünümündeki son numara — uygulama yeniden başlasa da
  /// numaralandırma buradan sürer (cihazda kalıcı depo gerekmez).
  TelemetryBuffer({required int lastSequence, required Duration interval})
    : _nextSequence = lastSequence + 1,
      _interval = interval < minSpacing ? minSpacing : interval;

  int _nextSequence;
  Duration _interval;
  DateTime? _lastRecorded;
  final _pending = <TelemetrySample>[];

  Duration get interval => _interval;
  int get pendingCount => _pending.length;
  List<TelemetrySample> get pending => List.unmodifiable(_pending);

  /// Sunucu aralığı değiştirebilir (ingest yanıtı `telemetryIntervalSeconds`).
  set interval(Duration value) =>
      _interval = value < minSpacing ? minSpacing : value;

  /// Okumayı kaydeder; aralık dolmadıysa `false` (numara tüketilmez).
  bool record(LocationReading reading) {
    final last = _lastRecorded;
    if (last != null && reading.capturedAt.difference(last) < _interval) {
      return false;
    }
    _pending.add(TelemetrySample(_nextSequence++, reading));
    _lastRecorded = reading.capturedAt;
    return true;
  }

  /// Gönderilecek parti (en eskiler önce). Sunucunun zaten reddedeceği bayat örnekler atılır.
  List<TelemetrySample> nextBatch(DateTime now) {
    _pending.removeWhere(
      (s) => now.difference(s.reading.capturedAt) > maxSampleAge,
    );
    return _pending.take(maxSamplesPerBatch).toList();
  }

  /// Sunucu partiyi **işledi** (her örnek kabul ya da ret): hepsi tüketilmiştir, bırakılır.
  /// Ağ hatasında çağrılmaz — aynı örnekler aynı numaralarla tekrar gönderilir; sunucu
  /// ilkini işlemişse `SEQUENCE_REPLAY` döner, çift kayıt olmaz.
  void acknowledge(Iterable<int> sequences) {
    final done = sequences.toSet();
    _pending.removeWhere((s) => done.contains(s.sequence));
  }
}
