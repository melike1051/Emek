import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:emek_mobile/auth/auth_adapter.dart';
import 'package:emek_mobile/config/env.dart';
import 'package:emek_mobile/features/provider/provider_bookings.dart';
import 'package:emek_mobile/main.dart';
import 'package:emek_mobile/session/providers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:integration_test/integration_test.dart';

/// Simülatörde, gerçek core API'ye karşı sağlayıcının hizmet günü: kabul → (müşteri öder) →
/// yola çık → var → "önce" fotoğrafı (gerçek dev storage, SHA-256 doğrulaması) → başlat.
/// Önkoşul: `npx tsx e2e/scripts/seed-mobile-provider-booking.ts` çıktısı `--dart-define` ile.
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

  testWidgets(
    'gerçek backend: sağlayıcı kabul → yola çık → var → kanıt → başlat',
    (tester) async {
      expect(
        _bookingId,
        isNotEmpty,
        reason: 'seed-mobile-provider-booking çıktısını verin',
      );
      // Kamera yerine sabit baytlar (simülatörde kamera yok); yükleme yolu gerçektir.
      final photo = Uint8List.fromList(
        utf8.encode('emek-mobile-evidence-${Random().nextInt(1 << 30)}'),
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
            evidencePickerProvider.overrideWithValue(
              (_) async => (bytes: photo, contentType: 'image/jpeg'),
            ),
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
      await _settleUntil(tester, find.text('HAZIRLIK'));

      // Sıradaki işler → randevu.
      await tester.tap(find.text('Yanıtınız bekleniyor'));
      await _settleUntil(tester, find.text('Randevuyu kabul et'));
      await tester.tap(find.text('Randevuyu kabul et'));
      await tester.pump();
      await tester.tap(find.text('Evet, kabul ediyorum'));
      await _settleUntil(tester, find.text('Müşteri ödemesi bekleniyor'));

      // Müşteri başka cihazda öder (API).
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
      await _step(tester, 'Adrese vardım', 'Evet, adresteyim', 'Adrestesiniz');

      await tester.tap(find.text('Galeriden').first);
      await _settleUntil(tester, find.textContaining('SHA-256'));
      expect(find.text('Önce'), findsOneWidget);

      await _step(
        tester,
        'Hizmeti başlat',
        'Evet, başlıyorum',
        'Hizmet sürüyor',
      );
    },
  );
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

Future<void> _settleUntil(WidgetTester tester, Finder target) async {
  for (var i = 0; i < 150 && target.evaluate().isEmpty; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
  await tester.pumpAndSettle();
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
