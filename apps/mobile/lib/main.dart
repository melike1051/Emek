import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'auth/auth_adapter.dart';
import 'auth/firebase_auth_adapter.dart';
import 'config/env.dart';
import 'push/fcm_token_source.dart';
import 'push/push_registrar.dart';
import 'router.dart';
import 'session/providers.dart';
import 'telemetry/telemetry_controller.dart';
import 'theme/theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final env = AppEnv.fromEnvironment();
  final AuthAdapter auth = switch (env.authMode) {
    AuthMode.mock => MockAuthAdapter(),
    AuthMode.firebase => await FirebaseAuthAdapter.initialize(env.firebase!),
  };
  // Push yalnız firebase modunda (yerelde Firebase projesi yok → mock modda push yok).
  final PushTokenSource push = env.authMode == AuthMode.firebase
      ? FcmTokenSource(FirebaseMessaging.instance)
      : const NoPushTokenSource();
  runApp(
    ProviderScope(
      retry: providerRetry,
      overrides: [
        envProvider.overrideWithValue(env),
        authAdapterProvider.overrideWithValue(auth),
        pushTokenSourceProvider.overrideWithValue(push),
      ],
      child: const EmekApp(),
    ),
  );
}

class EmekApp extends ConsumerWidget {
  const EmekApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Hizmet oturumu telemetrisi uygulama kökünde eşitlenir: Riverpod 3, görünmeyen widget'ların
    // izlediği sağlayıcıları duraklatır; kabuk bir ayrıntı ekranının altındayken "hizmet bitti"
    // geçişi telemetriyi durdurmazdı. Kök her zaman görünürdür.
    ref.watch(telemetryAutostartProvider);
    ref
      ..watch(pushAutoRegisterProvider)
      ..watch(pushNavigationProvider);
    return MaterialApp.router(
      title: 'Emek',
      theme: buildEmekTheme(),
      routerConfig: ref.watch(routerProvider),
      debugShowCheckedModeBanner: false,
      // Tek dil (ADR-0025): tarih/saat seçicileri ve sistem metinleri Türkçe.
      locale: const Locale('tr', 'TR'),
      supportedLocales: const [Locale('tr', 'TR')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
    );
  }
}
