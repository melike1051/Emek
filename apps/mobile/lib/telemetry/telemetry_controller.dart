import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/customer_api.dart';
import '../features/customer/customer_providers.dart';
import '../features/provider/provider_providers.dart';
import '../session/providers.dart';
import 'geolocator_source.dart';
import 'telemetry_engine.dart';

/// Platform konum kaynağı ve izin isteği — testlerde değiştirilir.
final locationSourceProvider = Provider<LocationSource>(
  (ref) => GeolocatorSource(),
);
final locationAccessProvider = Provider<Future<LocationAccess> Function()>(
  (ref) => ensureLocationAccess,
);

/// Tek seferlik konum (adres/bölge doldurma) — testlerde değiştirilir. `null`: izin yok.
typedef Coordinates = ({double latitude, double longitude});
final currentLocationProvider = Provider<Future<Coordinates?> Function()>(
  (ref) => () async {
    final position = await currentPositionOnce();
    return position == null
        ? null
        : (latitude: position.latitude, longitude: position.longitude);
  },
);

/// Telemetrinin kullanıcıya görünen durumu.
class TelemetryState {
  const TelemetryState({this.sessionId, this.status, this.access, this.error});
  final String? sessionId;

  /// Başlatma hatası (ör. konum eklentisi); ekranda gösterilir, sessizce yutulmaz.
  final Object? error;
  final TelemetryStatus? status;

  /// Son izin sonucu; reddedildiyse ekran ne yapılacağını söyler.
  final LocationAccess? access;

  bool get running => status?.phase == TelemetryPhase.running;
}

/// Tek kural: telemetri **yalnız** sunucunun `telemetryExpectedFromYou` dediği oturumda çalışır
/// (sağlayıcı, `ARRIVAL_MONITORING`/`ACTIVE`). Başka her durumda motor durdurulur.
class TelemetryController extends Notifier<TelemetryState> {
  TelemetryEngine? _engine;

  /// Eşitleme çağrıları sıraya alınır: otomatik başlatma ile güvenlik ekranı aynı anda
  /// çağırırsa iki motor (iki konum akışı) açılmaz.
  Future<void> _queue = Future.value();

  @override
  TelemetryState build() {
    // Çıkışta konum toplama hemen durur.
    ref.listen(signedInProvider, (_, next) {
      if (next.value == false) stop();
    });
    ref.onDispose(() => _engine?.stop());
    return const TelemetryState();
  }

  /// Oturum görünümüne göre başlat/sürdür/durdur. Aynı oturum zaten çalışıyorsa dokunmaz.
  Future<void> sync(SafetySession? session) =>
      _queue = _queue.then((_) => _sync(session)).catchError(_fail);

  void _fail(Object error) {
    if (!ref.mounted) return;
    state = TelemetryState(sessionId: state.sessionId, error: error);
  }

  Future<void> _sync(SafetySession? session) async {
    if (session == null || !session.telemetryExpectedFromYou) {
      if (session == null || session.sessionId == state.sessionId) {
        await _stop();
      }
      return;
    }
    final engine = _engine;
    if (engine != null &&
        engine.sessionId == session.sessionId &&
        engine.phase == TelemetryPhase.running) {
      return;
    }
    await _stop();

    final access = await ref.read(locationAccessProvider)();
    if (access != LocationAccess.granted) {
      state = TelemetryState(sessionId: session.sessionId, access: access);
      return;
    }
    final started = TelemetryEngine(
      sessionId: session.sessionId,
      client: ref.read(apiClientProvider),
      source: ref.read(locationSourceProvider),
      lastSequence: session.lastSequence,
      interval: Duration(seconds: session.telemetryIntervalSeconds),
      onStatus: (status) {
        // Denetleyici atılırken motorun son durum bildirimi yok sayılır.
        if (!ref.mounted) return;
        state = TelemetryState(
          sessionId: session.sessionId,
          status: status,
          access: access,
        );
      },
    );
    _engine = started;
    await started.start();
  }

  Future<void> stop() => _queue = _queue.then((_) => _stop()).catchError(_fail);

  Future<void> _stop() async {
    final engine = _engine;
    _engine = null;
    await engine?.stop();
    if (ref.mounted) state = const TelemetryState();
  }
}

final telemetryControllerProvider =
    NotifierProvider<TelemetryController, TelemetryState>(
      TelemetryController.new,
    );

/// Sağlayıcının yolda/adreste/hizmette olduğu randevu durumları (oturum telemetri bekler).
const _telemetryStatuses = {'PROVIDER_ARRIVING', 'CHECKED_IN', 'IN_PROGRESS'};

/// Uygulama kökü bunu izler: uygulama yeniden açıldığında ya da bir geçişten sonra
/// (`bookingsProvider` tazelenince) aktif randevunun oturumu okunur ve telemetri eşitlenir.
final telemetryAutostartProvider = FutureProvider.autoDispose<void>((
  ref,
) async {
  // Denetleyici baştan okunur: sağlayıcı yeniden kurulurken eski çalışma `ref` kullanamaz
  // (Riverpod 3); her beklemeden sonra `ref.mounted` ile eski çalışma sessizce çıkar.
  final controller = ref.read(telemetryControllerProvider.notifier);
  final api = ref.read(customerApiProvider);
  // Sağlayıcı profili olmayan (ya da oturumsuz) kullanıcı için hiçbir istek yapılmaz.
  final session = await ref.watch(sessionProvider.future);
  if (!ref.mounted) return;
  if (session?.provider == null) {
    await controller.stop();
    return;
  }
  final bookings = await ref.watch(providerBookingsProvider.future);
  if (!ref.mounted) return;
  final active = bookings
      .where((b) => _telemetryStatuses.contains(b.status))
      .firstOrNull;
  if (active == null) {
    await controller.stop();
    return;
  }
  final safety = await api.safetySession(active.id);
  if (!ref.mounted) return;
  await controller.sync(safety);
});
