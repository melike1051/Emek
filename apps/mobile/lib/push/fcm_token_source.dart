import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

import 'push_registrar.dart';

/// Firebase Cloud Messaging. Yalnız firebase modunda (Firebase başlatıldıktan sonra) kullanılır.
/// iOS'ta APNs token'ı gerekir (gerçek cihaz + Apple Push yeteneği; simülatörde token yok).
class FcmTokenSource implements PushTokenSource {
  FcmTokenSource(this._messaging);

  final FirebaseMessaging _messaging;

  @override
  Future<bool> requestPermission() async {
    final settings = await _messaging.requestPermission();
    return settings.authorizationStatus == AuthorizationStatus.authorized ||
        settings.authorizationStatus == AuthorizationStatus.provisional;
  }

  @override
  Future<String?> token() => _messaging.getToken();

  @override
  Stream<String> get tokenRefreshes => _messaging.onTokenRefresh;

  @override
  Stream<Map<String, String>> get foregroundMessages => FirebaseMessaging
      .onMessage
      .map((m) => {for (final e in m.data.entries) e.key: '${e.value}'});

  @override
  Future<String?> initialRoute() async =>
      (await _messaging.getInitialMessage())?.data['route'] as String?;

  @override
  Stream<String> get openedRoutes => FirebaseMessaging.onMessageOpenedApp
      .map((m) => m.data['route'])
      .where((r) => r is String)
      .cast<String>();

  @override
  String get platform =>
      defaultTargetPlatform == TargetPlatform.iOS ? 'IOS' : 'ANDROID';
}
