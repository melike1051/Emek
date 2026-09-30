import 'dart:async';

import '../api/api_client.dart';
import '../api/api_error.dart';
import 'telemetry_buffer.dart';

/// Konum kaynağı (platform). Yalnız [start] ile [stop] arasında okuma yapar.
abstract interface class LocationSource {
  Stream<LocationReading> start({required Duration interval});
  Future<void> stop();
}

enum TelemetryPhase { idle, running, stopped }

/// Kullanıcıya gösterilen durum (dar: konum değerleri gösterilmez).
class TelemetryStatus {
  const TelemetryStatus({
    required this.phase,
    this.pending = 0,
    this.lastSentAt,
    this.lastError,
  });
  final TelemetryPhase phase;
  final int pending;
  final DateTime? lastSentAt;
  final Object? lastError;
}

/// Bir güvenlik oturumunun telemetri döngüsü: kaynak → tampon → partiler halinde gönderim.
///
/// Oturum telemetri kabul etmeyi bıraktığında (`SAFETY_SESSION_NOT_ACTIVE` ya da oturum
/// kapandı) motor **kendini durdurur** — 24 saat takip yoktur (CLAUDE.md §4 Safety).
class TelemetryEngine {
  TelemetryEngine({
    required this.sessionId,
    required ApiClient client,
    required LocationSource source,
    required int lastSequence,
    required Duration interval,
    DateTime Function()? clock,
    this.onStatus,
  }) : _client = client,
       _source = source,
       _clock = clock ?? DateTime.now,
       buffer = TelemetryBuffer(lastSequence: lastSequence, interval: interval);

  final String sessionId;
  final ApiClient _client;
  final LocationSource _source;
  final DateTime Function() _clock;
  final void Function(TelemetryStatus status)? onStatus;
  final TelemetryBuffer buffer;

  StreamSubscription<LocationReading>? _subscription;
  Timer? _flushTimer;
  bool _sending = false;
  TelemetryPhase _phase = TelemetryPhase.idle;
  DateTime? _lastSentAt;
  Object? _lastError;

  TelemetryPhase get phase => _phase;

  Future<void> start() async {
    if (_phase != TelemetryPhase.idle) return;
    _phase = TelemetryPhase.running;
    _listen();
    _emit();
  }

  /// Kaynağı ve gönderim zamanlayıcısını tampondaki güncel aralıkla kurar.
  void _listen() {
    _subscription = _source
        .start(interval: buffer.interval)
        .listen(
          (reading) {
            if (buffer.record(reading)) _emit();
          },
          onError: (Object error) {
            _lastError = error;
            _emit();
          },
        );
    // Gönderim aralığı örnekleme aralığıyla aynıdır; dakikada ≤ 60 istek sınırının çok altında.
    _flushTimer = Timer.periodic(buffer.interval, (_) => unawaited(flush()));
  }

  /// Sunucu aralığı değiştirdiyse (R-113) kaynak ve zamanlayıcı yeni aralıkla yeniden kurulur;
  /// yalnız tampon kuralına yansıtmak cihazı eski sıklıkta örneklemeye bırakırdı.
  Future<void> _restartWithInterval(Duration interval) async {
    final previous = buffer.interval;
    buffer.interval = interval;
    if (buffer.interval == previous || _phase != TelemetryPhase.running) return;
    _flushTimer?.cancel();
    try {
      await _source.stop();
      await _subscription?.cancel();
    } catch (error) {
      // Platform hatası motoru zamanlayıcısız bırakmamalı: yine de yeniden kurulur, hata görünür.
      _lastError = error;
    } finally {
      // Bu arada durdurulduysa kaynak yeniden açılmaz (gizlilik: stop kesindir).
      if (_phase == TelemetryPhase.running) _listen();
    }
  }

  /// Bekleyenleri gönderir. Aynı anda tek gönderim; ağ hatasında örnekler tamponda kalır.
  Future<void> flush() async {
    if (_sending || _phase != TelemetryPhase.running) return;
    final batch = buffer.nextBatch(_clock());
    if (batch.isEmpty) return;
    _sending = true;
    try {
      final response =
          (await _client.post(
                '/safety/sessions/${ApiClient.segment(sessionId)}/telemetry',
                body: {
                  'samples': [for (final s in batch) s.toJson()],
                },
              ))!
              as Map<String, dynamic>;
      // Sunucu partinin **her** örneğini işledi (kabul ya da ret): hepsi tüketildi.
      buffer.acknowledge(batch.map((s) => s.sequence));
      final interval = response['telemetryIntervalSeconds'];
      if (interval is int) {
        await _restartWithInterval(Duration(seconds: interval));
      }
      _lastSentAt = _clock();
      _lastError = null;
    } on ApiError catch (error) {
      _lastError = error;
      if (error.code == 'SAFETY_SESSION_NOT_ACTIVE' ||
          error.code == 'SAFETY_SESSION_ALREADY_CLOSED' ||
          error.code == 'SAFETY_SESSION_NOT_FOUND') {
        await stop();
        return;
      }
      if (!error.isRetryable &&
          !error.isAmbiguous &&
          !error.isUnauthenticated) {
        // Sözleşme hatası (ör. doğrulama): aynı parti asla kabul edilmez — takılıp kalmamak için
        // bırakılır. Numaralar tüketilmiş sayılır; sıradaki örnekler daha büyük numarayla gider.
        buffer.acknowledge(batch.map((s) => s.sequence));
      }
    } finally {
      _sending = false;
      _emit();
    }
  }

  Future<void> stop() async {
    if (_phase == TelemetryPhase.stopped) return;
    _phase = TelemetryPhase.stopped;
    _flushTimer?.cancel();
    // Önce donanım: konum toplamanın durması gizlilik açısından kritik adımdır ve hiçbir şeyin
    // (ör. abonelik iptalinin tamamlanmasının) arkasında beklememelidir.
    await _source.stop();
    await _subscription?.cancel();
    _emit();
  }

  void _emit() => onStatus?.call(
    TelemetryStatus(
      phase: _phase,
      pending: buffer.pendingCount,
      lastSentAt: _lastSentAt,
      lastError: _lastError,
    ),
  );
}
