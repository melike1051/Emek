import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/api_client.dart';
import '../api/api_error.dart';
import '../auth/auth_adapter.dart';
import '../config/env.dart';
import 'session.dart';

/// Okuma sağlayıcılarının otomatik yeniden denemesi (Riverpod 3 varsayılanı her hatayı
/// tekrarlar). Web `shouldRetry` ile aynı: yalnız geçici hatalar (ağ, 429, 503), en çok 2 kez;
/// 4xx iş hataları asla. Komutlar (mutasyon) zaten sağlayıcı değildir, otomatik tekrar edilmez.
Duration? providerRetry(int retryCount, Object error) {
  if (retryCount >= 2 || error is! ApiError || !error.isRetryable) return null;
  return Duration(milliseconds: 500 * (1 << retryCount));
}

/// `main.dart`'ta (ve testlerde) override edilir.
final envProvider = Provider<AppEnv>(
  (ref) => throw UnimplementedError('envProvider'),
);
final authAdapterProvider = Provider<AuthAdapter>(
  (ref) => throw UnimplementedError('authAdapterProvider'),
);

final apiClientProvider = Provider<ApiClient>((ref) {
  final auth = ref.watch(authAdapterProvider);
  return ApiClient(
    baseUrl: ref.watch(envProvider).apiBaseUrl,
    idToken: auth.idToken,
    appCheckToken: auth.appCheckToken,
  );
});

final signedInProvider = StreamProvider<bool>(
  (ref) => ref.watch(authAdapterProvider).signedInChanges,
);

/// Oturum: giriş yoksa `null`; varsa backend oturumu + profiller. Profil oluşturulunca
/// `ref.invalidate(sessionProvider)` ile yeniden kurulur.
final sessionProvider = FutureProvider<Session?>((ref) async {
  final signedIn = await ref.watch(signedInProvider.future);
  if (!signedIn) return null;
  return SessionApi(ref.watch(apiClientProvider)).bootstrap();
});
