import 'dart:math';

import 'package:emek_mobile/auth/auth_adapter.dart';
import 'package:emek_mobile/config/env.dart';
import 'package:emek_mobile/main.dart';
import 'package:emek_mobile/session/providers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:integration_test/integration_test.dart';

/// Simülatörde **gerçek konum kaynağı** (geolocator) + gerçek core API: sağlayıcı yola çıkınca
/// konum akışı başlar ve güvenlik oturumuna gider. Önkoşul (simülatör):
/// `xcrun simctl privacy <udid> grant location tr.emek.emekMobile` ve
/// `xcrun simctl location <udid> set <E2E_PENDING_LAT>,<E2E_PENDING_LON>`.
const _api = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'http://localhost:3000',
);
const _bookingId = String.fromEnvironment('E2E_PENDING_BOOKING_ID');
const _providerSubject = String.fromEnvironment('E2E_PENDING_PROVIDER_SUBJECT');
const _providerPhone = String.fromEnvironment('E2E_PENDING_PROVIDER_PHONE');
const _customerSubject = String.fromEnvironment('E2E_PENDING_CUSTOMER_SUBJECT');

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('gerçek konum: yola çıkınca telemetri başlar ve sunucuya gider', (
    tester,
  ) async {
    expect(
      _bookingId,
      isNotEmpty,
      reason: 'seed-mobile-provider-booking çıktısını verin',
    );
    await tester.pumpWidget(
      ProviderScope(
        retry: providerRetry,
        overrides: [
          envProvider.overrideWithValue(
            AppEnv.parse({
              'AUTH_MODE': 'mock',
              'API_BASE_URL': _api,
            }, isRelease: false),
          ),
          authAdapterProvider.overrideWithValue(MockAuthAdapter()),
        ],
        child: const EmekApp(),
      ),
    );
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const Key('login.subject')),
      _providerSubject,
    );
    await tester.enterText(
      find.byKey(const Key('login.phone')),
      _providerPhone,
    );
    await tester.tap(find.text('Giriş yap'));
    await _settleUntil(tester, find.text('Yanıtınız bekleniyor'));
    await tester.tap(find.text('Yanıtınız bekleniyor'));
    await _step(
      tester,
      'Randevuyu kabul et',
      'Evet, kabul ediyorum',
      'Müşteri ödemesi bekleniyor',
    );

    final pay = await http.post(
      Uri.parse('$_api/api/v1/bookings/$_bookingId/payment'),
      headers: {
        'Authorization': 'Bearer mock:$_customerSubject',
        'Idempotency-Key': 'mobile-it-pay-${Random().nextInt(1 << 30)}',
      },
    );
    expect(pay.statusCode, anyOf(200, 201), reason: pay.body);
    await tester.fling(
      find.text('Müşteri ödemesi bekleniyor'),
      const Offset(0, 500),
      1500,
    );

    await _step(tester, 'Yola çıktım', 'Evet, yola çıkıyorum', 'Yoldasınız');
    await tester.tap(find.text('Güvenlik & oturum'));
    await _settleUntil(tester, find.text('KONUM PAYLAŞIMI'));

    // İlk parti bir aralık (30 sn) içinde gider.
    await _settleUntil(
      tester,
      find.textContaining('Son gönderim:'),
      seconds: 75,
    );
    expect(find.text('Açık'), findsOneWidget);
  });
}

Future<void> _step(
  WidgetTester tester,
  String label,
  String confirm,
  String after,
) async {
  await _settleUntil(tester, find.text(label));
  await tester.ensureVisible(find.text(label));
  await tester.tap(find.text(label));
  await tester.pumpAndSettle();
  await tester.tap(find.text(confirm));
  await _settleUntil(tester, find.text(after));
}

Future<void> _settleUntil(
  WidgetTester tester,
  Finder target, {
  int seconds = 15,
}) async {
  for (var i = 0; i < seconds * 10 && target.evaluate().isEmpty; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
  if (target.evaluate().isNotEmpty) await tester.pumpAndSettle();
  if (target.evaluate().isEmpty) {
    final texts = find
        .byType(Text)
        .evaluate()
        .map((e) => (e.widget as Text).data)
        .whereType<String>()
        .join(' | ');
    fail('Beklenen görünmedi: $target. Ekrandaki metinler: $texts');
  }
}
