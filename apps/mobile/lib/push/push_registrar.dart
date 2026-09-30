import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/api_client.dart';
import '../features/customer/customer_providers.dart';
import '../router.dart';
import '../session/providers.dart';

/// Push token kaynağı (platform). Firebase modunda FCM; mock modda yok (yerel Firebase projesi
/// yok). Testlerde değiştirilir.
abstract interface class PushTokenSource {
  /// Bildirim izni ister; verilmezse `false` (push kaydı yapılmaz, uygulama çalışmaya devam eder).
  Future<bool> requestPermission();
  Future<String?> token();
  Stream<String> get tokenRefreshes;

  /// Uygulama açıkken gelen bildirimler (veri tazeleme için).
  Stream<Map<String, String>> get foregroundMessages;

  /// Bildirime dokunulunca açılan rota (uygulama kapalıyken dokunulduysa ilk değer).
  Future<String?> initialRoute();
  Stream<String> get openedRoutes;
  String get platform;
}

/// Mock mod: push yok.
class NoPushTokenSource implements PushTokenSource {
  const NoPushTokenSource();
  @override
  Future<bool> requestPermission() async => false;
  @override
  Future<String?> token() async => null;
  @override
  Stream<String> get tokenRefreshes => const Stream.empty();
  @override
  Stream<Map<String, String>> get foregroundMessages => const Stream.empty();
  @override
  Future<String?> initialRoute() async => null;
  @override
  Stream<String> get openedRoutes => const Stream.empty();
  @override
  String get platform =>
      defaultTargetPlatform == TargetPlatform.iOS ? 'IOS' : 'ANDROID';
}

final pushTokenSourceProvider = Provider<PushTokenSource>(
  (ref) => const NoPushTokenSource(),
);

/// Bildirimin açabileceği rotalar — **izin listesi**. Push `data` alanı güvenilmez girdidir:
/// yalnız randevu ayrıntısına götürür, başka hiçbir yere değil.
final _allowedRoute = RegExp(
  r'^/(panel/)?randevular/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
);

String? safePushRoute(String? route) =>
    route != null && _allowedRoute.hasMatch(route) ? route : null;

/// Oturum açıkken cihaz token'ını backend'e kaydeder; çıkışta **önce** kaydı siler, sonra
/// oturumu kapatır (silme isteği hâlâ kimlik taşır). Token yalnız bellekte tutulur.
class PushRegistrar extends Notifier<String?> {
  StreamSubscription<String>? _refreshes;
  StreamSubscription<Map<String, String>>? _foreground;

  /// Çıkışta artar: çıkıştan önce başlamış bir kayıt, bittiğinde yeni abonelik kurmaz.
  int _generation = 0;

  /// Süren kayıt isteği. Çıkış bunu bekler: aksi hâlde yanıtı gelmemiş kayıt çıkıştan sonra
  /// tamamlanır ve cihaz, çıkış yapmış hesaba bildirim almaya devam ederdi.
  Future<void>? _inFlight;

  /// Son kaydın cihaz kimliği (`DELETE /users/me/devices/:id` için).
  @override
  String? build() {
    ref.onDispose(() {
      _refreshes?.cancel();
      _foreground?.cancel();
    });
    return null;
  }

  ApiClient get _api => ref.read(apiClientProvider);
  PushTokenSource get _source => ref.read(pushTokenSourceProvider);

  Future<void> register() async {
    final generation = _generation;
    bool current() => ref.mounted && generation == _generation;
    if (!await _source.requestPermission() || !current()) return;
    final token = await _source.token();
    if (token == null || !current()) return;
    await _send(token);
    if (!current()) return;
    unawaited(_refreshes?.cancel());
    _refreshes = _source.tokenRefreshes.listen(_send);
    unawaited(_foreground?.cancel());
    // Uygulama açıkken gelen bildirim: gösterilen veriyi tazele (ör. sağlayıcı onayladı).
    _foreground = _source.foregroundMessages.listen((_) {
      if (ref.mounted) ref.invalidate(bookingsProvider);
    });
  }

  Future<void> _send(String token) {
    final previous = _inFlight ?? Future<void>.value();
    final sending = previous.then((_) => _post(token));
    _inFlight = sending;
    return sending;
  }

  Future<void> _post(String token) async {
    try {
      final response =
          (await _api.post(
                '/users/me/devices',
                body: {'token': token, 'platform': _source.platform},
              ))!
              as Map<String, dynamic>;
      if (ref.mounted) state = response['id'] as String;
    } on Exception {
      // Kayıt başarısız: bildirimsiz devam edilir; bir sonraki açılışta yeniden denenir.
    }
  }

  /// Çıkış: cihaz kaydı silinir (bu cihaza artık bu hesabın bildirimi gitmez), sonra oturum.
  Future<void> signOut() async {
    _generation += 1;
    // İptaller beklenmez: hiçbir şey tamamlanmalarına bağlı değildir ve bir akışın iptal
    // future'ı gecikirse çıkış takılırdı.
    unawaited(_refreshes?.cancel());
    unawaited(_foreground?.cancel());
    _refreshes = null;
    _foreground = null;
    // Süren kayıt önce biter (istemci zaman aşımıyla sınırlı), sonra onun kimliği silinir.
    await _inFlight;
    _inFlight = null;
    final deviceId = state;
    if (deviceId != null) {
      try {
        await _api.delete('/users/me/devices/${ApiClient.segment(deviceId)}');
      } on Exception {
        // Silinemezse (ağ yok) token 90 gün sonra retention ile düşer; çıkış engellenmez.
      }
    }
    if (ref.mounted) state = null;
    await ref.read(authAdapterProvider).signOut();
  }
}

final pushRegistrarProvider = NotifierProvider<PushRegistrar, String?>(
  PushRegistrar.new,
);

/// Oturum kurulunca push kaydı (uygulama kökünden izlenir).
final pushAutoRegisterProvider = FutureProvider.autoDispose<void>((ref) async {
  final registrar = ref.read(pushRegistrarProvider.notifier);
  final session = await ref.watch(sessionProvider.future);
  if (!ref.mounted || session == null) return;
  await registrar.register();
});

/// Bildirime dokunulunca ilgili randevu açılır — yalnız izin listesindeki rotalar
/// ([safePushRoute]); oturum yoksa router girişe yönlendirir.
final pushNavigationProvider = Provider<void>((ref) {
  final source = ref.watch(pushTokenSourceProvider);
  void open(String? route) {
    final safe = safePushRoute(route);
    if (safe != null) ref.read(routerProvider).go(safe);
  }

  unawaited(source.initialRoute().then(open));
  final subscription = source.openedRoutes.listen(open);
  ref.onDispose(subscription.cancel);
});
