import 'dart:math';

import 'package:emek_mobile/auth/auth_adapter.dart';
import 'package:emek_mobile/config/env.dart';
import 'package:emek_mobile/main.dart';
import 'package:emek_mobile/session/providers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

/// Simülatörde, gerçek yerel core API'ye karşı (ADR-0025 §Test). Önkoşul: API ayakta,
/// `AUTH_PROVIDER=mock`. Çalıştırma:
/// `flutter test integration_test -d <simülatör> --dart-define=API_BASE_URL=http://localhost:3000`
/// (Android emülatöründe `http://10.0.2.2:3000`).
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('gerçek API: mock giriş → rol seçimi → müşteri profili → keşfet', (
    tester,
  ) async {
    final env = AppEnv.parse({
      'AUTH_MODE': 'mock',
      'API_BASE_URL': const String.fromEnvironment(
        'API_BASE_URL',
        defaultValue: 'http://localhost:3000',
      ),
    }, isRelease: false);
    final random = Random();
    final subject = 'mob-it-${random.nextInt(1 << 32).toRadixString(16)}';
    final phone = '053${random.nextInt(100000000).toString().padLeft(8, '0')}';

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          envProvider.overrideWithValue(env),
          authAdapterProvider.overrideWithValue(MockAuthAdapter()),
        ],
        child: const EmekApp(),
      ),
    );
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(const Key('login.subject')), subject);
    await tester.enterText(find.byKey(const Key('login.phone')), phone);
    await tester.tap(find.text('Giriş yap'));
    await _settleUntil(
      tester,
      find.text("Emek'te nasıl yer almak istersiniz?"),
    );

    await tester.tap(find.text('Hizmet almak istiyorum'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('role.name')),
      'Simülatör Müşteri',
    );
    await tester.tap(find.text('Devam et'));
    await _settleUntil(
      tester,
      find.text('Eviniz ve sevdikleriniz için güvenilir eller.'),
    );

    // Aynı kimlikle yeniden giriş aynı kullanıcıyı ve profili açar (backend idempotent).
    // `find.byTooltip` cihazda tooltip'in kendi (ekran dışı) yerleşim kutusunu bulur;
    // kullanıcının dokunduğu şey simgedir.
    await tester.tap(find.byIcon(Icons.logout));
    await _settleUntil(tester, find.text("Emek'e hoş geldiniz"));
    await tester.enterText(find.byKey(const Key('login.subject')), subject);
    await tester.enterText(find.byKey(const Key('login.phone')), phone);
    await tester.tap(find.text('Giriş yap'));
    await _settleUntil(
      tester,
      find.text('Eviniz ve sevdikleriniz için güvenilir eller.'),
    );
  });
}

/// Gerçek ağ isteği sürerken `pumpAndSettle` erken dönebilir; hedef görünene dek pompalar,
/// sonra sayfa geçişi animasyonunun bitmesini bekler (yoksa dokunuş kayan sayfayı ıskalar).
Future<void> _settleUntil(WidgetTester tester, Finder target) async {
  for (var i = 0; i < 100 && target.evaluate().isEmpty; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
  await tester.pumpAndSettle();
  if (target.evaluate().isEmpty) {
    // Başarısızlıkta ekranda ne olduğunu raporla (hata ayıklamayı kısaltır).
    final texts = find
        .byType(Text)
        .evaluate()
        .map((e) => (e.widget as Text).data)
        .whereType<String>()
        .join(' | ');
    fail('Beklenen görünmedi: $target. Ekrandaki metinler: $texts');
  }
}
