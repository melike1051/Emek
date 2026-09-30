import 'dart:convert';
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

/// Simülatörde, gerçek core API + **AI servisi (:8000)** + seed'li sağlayıcıya karşı müşteri akışı.
/// Önkoşul: `npx tsx e2e/scripts/seed-mobile-provider.ts` çıktısındaki değerler
/// `--dart-define` ile verilir (E2E_LAT, E2E_LON, E2E_PROVIDER_SUBJECT, E2E_PROVIDER_NAME).
const _api = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'http://localhost:3000',
);
const _lat = String.fromEnvironment('E2E_LAT');
const _lon = String.fromEnvironment('E2E_LON');
const _providerSubject = String.fromEnvironment('E2E_PROVIDER_SUBJECT');
const _providerName = String.fromEnvironment('E2E_PROVIDER_NAME');

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('gerçek backend: talep → eşleşme → sağlayıcı onayı → ödeme', (
    tester,
  ) async {
    expect(
      _providerSubject,
      isNotEmpty,
      reason: 'seed-mobile-provider çıktısını verin',
    );
    final random = Random();
    final subject = 'mob-cust-${random.nextInt(1 << 32).toRadixString(16)}';
    final phone = '053${random.nextInt(100000000).toString().padLeft(8, '0')}';

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

    // Giriş + müşteri profili.
    await tester.enterText(find.byKey(const Key('login.subject')), subject);
    await tester.enterText(find.byKey(const Key('login.phone')), phone);
    await _tap(tester, find.text('Giriş yap'));
    await _settleUntil(tester, find.text('Hizmet almak istiyorum'));
    await _tap(tester, find.text('Hizmet almak istiyorum'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('role.name')), 'Mobil Müşteri');
    await _tap(tester, find.text('Devam et'));
    await _settleUntil(tester, find.text('Adresi kaydet'));

    // Adres (sağlayıcının hizmet bölgesinde).
    await tester.enterText(find.byKey(const Key('address.city')), 'Kırşehir');
    await tester.enterText(find.byKey(const Key('address.district')), 'Merkez');
    await tester.enterText(
      find.byKey(const Key('address.line')),
      'Mobil Test Sokak No 1',
    );
    await tester.enterText(find.byKey(const Key('address.latitude')), _lat);
    await tester.enterText(find.byKey(const Key('address.longitude')), _lon);
    await _tap(tester, find.text('Adresi kaydet'));
    await _settleUntil(tester, find.byKey(const Key('explore.address')));

    // Doğal dil talebi → gerçek AI ayrıştırması.
    await tester.enterText(
      find.byKey(const Key('explore.text')),
      'Yarın öğleden sonra 3 saatlik detaylı temizlik',
    );
    await tester.pump();
    await _tap(tester, find.text('Uygun sağlayıcıyı bul'));
    await _settleUntil(tester, find.text('Sağlayıcı bul'));
    expect(find.text('180 dakika'), findsOneWidget);

    // Eşleştirme → gerçek motor, gerekçeler.
    await _tap(tester, find.text('Sağlayıcı bul'));
    await _settleUntil(tester, find.text('Randevuya git'));
    expect(find.text(_providerName), findsOneWidget);
    // AI servisi ayakta (önkoşul): gerçek motor gerekçeleri, istemci metniyle.
    expect(find.text('Neden bu sağlayıcı?'), findsOneWidget);
    expect(find.text('Gerekli tüm becerileri doğrulanmış'), findsOneWidget);
    await _tap(tester, find.text('Randevuya git'));
    await _settleUntil(tester, find.text('Sağlayıcı onayı bekleniyor'));

    // Sağlayıcı başka cihazda onaylar (API).
    final bookingId = await _latestBookingId(subject);
    final confirm = await http.post(
      Uri.parse('$_api/api/v1/bookings/$bookingId/confirm'),
      headers: {
        'Authorization': 'Bearer mock:$_providerSubject',
        'Idempotency-Key': 'mobile-it-${random.nextInt(1 << 32)}',
      },
    );
    expect(confirm.statusCode, anyOf(200, 201), reason: confirm.body);

    // Aşağı çekerek yenile → ödeme.
    await tester.fling(
      find.text('Sağlayıcı onayı bekleniyor').first,
      const Offset(0, 500),
      1500,
    );
    await _settleUntil(tester, find.textContaining('ödemeyi onayla'));
    await _tap(tester, find.textContaining('ödemeyi onayla'));
    await _settleUntil(tester, find.text('Güvende tutuluyor'));
    expect(find.text('Planlandı'), findsWidgets);
  });
}

Future<String> _latestBookingId(String customerSubject) async {
  final response = await http.get(
    Uri.parse('$_api/api/v1/bookings'),
    headers: {'Authorization': 'Bearer mock:$customerSubject'},
  );
  final list = (jsonDecode(response.body) as List).cast<Map<String, dynamic>>();
  return list.first['id'] as String;
}

/// Gerçek ağ isteği sürerken `pumpAndSettle` erken dönebilir; hedef görünene dek pompalar,
/// sonra sayfa geçişinin bitmesini bekler.
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

/// Önce görünür alana kaydırır: Android'de klavye ve daha kısa ekran butonu görünümden çıkarır.
Future<void> _tap(WidgetTester tester, Finder target) async {
  await tester.ensureVisible(target);
  await tester.pumpAndSettle();
  await tester.tap(target);
}
