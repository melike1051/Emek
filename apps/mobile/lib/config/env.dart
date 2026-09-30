import 'package:flutter/foundation.dart';

/// Kimlik doğrulama modu (ADR-0025 §Auth). `mock` yalnız yerel geliştirme: backend
/// `AUTH_PROVIDER=mock` ile eşleşir; release build'de reddedilir.
enum AuthMode { firebase, mock }

/// Derleme zamanı yapılandırması (`--dart-define`). Sır değildir; gerçek proje değerleri
/// repoya yazılmaz.
class AppEnv {
  const AppEnv({
    required this.apiBaseUrl,
    required this.authMode,
    this.firebase,
  });

  /// Core API kökü, `/api/v1` hariç. Mobil API'ye **doğrudan** konuşur (web'deki gibi
  /// aynı-origin proxy yoktur; istemci IP'si için bkz. R-107).
  final Uri apiBaseUrl;
  final AuthMode authMode;
  final FirebaseEnv? firebase;

  /// `--dart-define` değerlerinden okur. [isRelease] test için enjekte edilir.
  static AppEnv parse(Map<String, String> raw, {required bool isRelease}) {
    final modeName = raw['AUTH_MODE'] ?? 'firebase';
    final mode = switch (modeName) {
      'firebase' => AuthMode.firebase,
      'mock' => AuthMode.mock,
      _ => throw StateError('AUTH_MODE geçersiz: $modeName'),
    };
    if (mode == AuthMode.mock && isRelease) {
      throw StateError('AUTH_MODE=mock release build ile kullanılamaz');
    }

    final base = Uri.tryParse(raw['API_BASE_URL'] ?? '');
    if (base == null || !base.hasScheme || base.host.isEmpty) {
      throw StateError(
        'API_BASE_URL mutlak bir URL olmalı (ör. http://10.0.2.2:3000)',
      );
    }
    if (isRelease && base.scheme != 'https') {
      throw StateError('Release build API_BASE_URL için https ister');
    }

    FirebaseEnv? firebase;
    if (mode == AuthMode.firebase) {
      firebase = FirebaseEnv.parse(raw);
    }
    return AppEnv(apiBaseUrl: base, authMode: mode, firebase: firebase);
  }

  static AppEnv fromEnvironment() => parse(const {
    'AUTH_MODE': String.fromEnvironment('AUTH_MODE', defaultValue: 'firebase'),
    'API_BASE_URL': String.fromEnvironment('API_BASE_URL'),
    'FIREBASE_API_KEY': String.fromEnvironment('FIREBASE_API_KEY'),
    'FIREBASE_APP_ID': String.fromEnvironment('FIREBASE_APP_ID'),
    'FIREBASE_PROJECT_ID': String.fromEnvironment('FIREBASE_PROJECT_ID'),
    'FIREBASE_MESSAGING_SENDER_ID': String.fromEnvironment(
      'FIREBASE_MESSAGING_SENDER_ID',
    ),
  }, isRelease: kReleaseMode);
}

class FirebaseEnv {
  const FirebaseEnv({
    required this.apiKey,
    required this.appId,
    required this.projectId,
    required this.messagingSenderId,
  });

  final String apiKey;
  final String appId;
  final String projectId;
  final String messagingSenderId;

  static FirebaseEnv parse(Map<String, String> raw) {
    String need(String key) {
      final value = raw[key] ?? '';
      if (value.isEmpty) {
        throw StateError('AUTH_MODE=firebase için $key zorunlu');
      }
      return value;
    }

    return FirebaseEnv(
      apiKey: need('FIREBASE_API_KEY'),
      appId: need('FIREBASE_APP_ID'),
      projectId: need('FIREBASE_PROJECT_ID'),
      messagingSenderId: need('FIREBASE_MESSAGING_SENDER_ID'),
    );
  }
}
