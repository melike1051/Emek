import 'dart:async';

import 'package:emek_mobile/push/push_registrar.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_backend.dart';

class FakePushSource implements PushTokenSource {
  FakePushSource({this.granted = true, this.initial});
  final bool granted;
  final String? initial;
  final refreshes = StreamController<String>.broadcast();
  final opened = StreamController<String>.broadcast();
  final foreground = StreamController<Map<String, String>>.broadcast();

  @override
  Future<bool> requestPermission() async => granted;
  @override
  Future<String?> token() async => 'fcm-token-1';
  @override
  Stream<String> get tokenRefreshes => refreshes.stream;
  @override
  Stream<Map<String, String>> get foregroundMessages => foreground.stream;
  @override
  Future<String?> initialRoute() async => initial;
  @override
  Stream<String> get openedRoutes => opened.stream;
  @override
  String get platform => 'IOS';
}

const bookingId = '0b9d8c1e-1111-4222-8333-444455556666';

void main() {
  test('safePushRoute: yalnız randevu ayrıntısı rotaları', () {
    expect(safePushRoute('/randevular/$bookingId'), '/randevular/$bookingId');
    expect(
      safePushRoute('/panel/randevular/$bookingId'),
      '/panel/randevular/$bookingId',
    );
    for (final bad in [
      null,
      '/panel/profil',
      '/randevular/$bookingId/guvenlik',
      'https://evil.example/randevular/$bookingId',
      '/randevular/../hesap',
      '/randevular/$bookingId?x=1',
    ]) {
      expect(safePushRoute(bad), isNull, reason: '$bad');
    }
  });

  FakeBackend backendFor() => FakeBackend({
    'POST /users/me/devices': (_) => json({
      'id': 'dev-1',
      'platform': 'IOS',
      'createdAt': '2026-09-29T10:00:00Z',
      'lastSeenAt': '2026-09-29T10:00:00Z',
    }),
    'DELETE /users/me/devices/dev-1': (_) => json({}, 204),
  });

  testWidgets(
    'oturum açılınca token kaydedilir; yenilenen token tekrar kaydedilir',
    (tester) async {
      final source = FakePushSource();
      final backend = backendFor();
      await pumpSignedInApp(tester, backend, pushSource: source);

      final first = backend.callsTo('POST', '/users/me/devices').single;
      expect(first.body, {'token': 'fcm-token-1', 'platform': 'IOS'});

      source.refreshes.add('fcm-token-2');
      await tester.pumpAndSettle();
      expect(backend.callsTo('POST', '/users/me/devices').last.body, {
        'token': 'fcm-token-2',
        'platform': 'IOS',
      });
    },
  );

  testWidgets('izin verilmezse kayıt yapılmaz, uygulama çalışır', (
    tester,
  ) async {
    final backend = backendFor();
    await pumpSignedInApp(
      tester,
      backend,
      pushSource: FakePushSource(granted: false),
    );
    expect(backend.callsTo('POST', '/users/me/devices'), isEmpty);
    expect(
      find.text('Eviniz ve sevdikleriniz için güvenilir eller.'),
      findsOneWidget,
    );
  });

  testWidgets(
    'çıkış: önce cihaz kaydı silinir (kimlikli), sonra oturum kapanır',
    (tester) async {
      final backend = backendFor();
      await pumpSignedInApp(tester, backend, pushSource: FakePushSource());

      await tester.tap(find.byIcon(Icons.logout));
      await tester.pumpAndSettle();

      final delete = backend
          .callsTo('DELETE', '/users/me/devices/dev-1')
          .single;
      expect(delete.headers['authorization'], startsWith('Bearer mock:'));
      expect(find.text("Emek'e hoş geldiniz"), findsOneWidget);
    },
  );

  testWidgets(
    'kayıt yanıtı gelmeden çıkış: kayıt bitince silinir, yeni abonelik kurulmaz',
    (tester) async {
      final source = FakePushSource();
      final release = Completer<void>();
      final backend = FakeBackend({
        ...backendFor().routes,
        'POST /users/me/devices': (call) async {
          await release.future;
          return backendFor().routes['POST /users/me/devices']!(call);
        },
      });
      await pumpSignedInApp(tester, backend, pushSource: source);
      expect(backend.callsTo('POST', '/users/me/devices'), hasLength(1));

      await tester.tap(find.byIcon(Icons.logout));
      await tester.pump();
      release.complete();
      await tester.pumpAndSettle();

      expect(
        backend.callsTo('DELETE', '/users/me/devices/dev-1'),
        hasLength(1),
      );
      expect(find.text("Emek'e hoş geldiniz"), findsOneWidget);
      // Çıkıştan sonra token yenilemesi hesapsız kayıt denemez.
      source.refreshes.add('fcm-token-2');
      await tester.pumpAndSettle();
      expect(backend.callsTo('POST', '/users/me/devices'), hasLength(1));
    },
  );

  testWidgets(
    'bildirime dokunma: izinli rota açılır, uydurma rota yok sayılır',
    (tester) async {
      final source = FakePushSource();
      final backend = FakeBackend({
        ...backendFor().routes,
        'GET /bookings/$bookingId': (_) => json({
          'id': bookingId,
          'customerId': 'u1',
          'providerId': 'p1',
          'serviceId': 's1',
          'addressId': 'a1',
          'scheduledStart': '2026-10-12T07:00:00Z',
          'scheduledEnd': '2026-10-12T10:00:00Z',
          'priceMinor': '96000',
          'currency': 'TRY',
          'status': 'CONFIRMED',
        }),
      });
      await pumpSignedInApp(tester, backend, pushSource: source);

      source.opened.add('/hesap-sil');
      await tester.pumpAndSettle();
      expect(
        find.text('Eviniz ve sevdikleriniz için güvenilir eller.'),
        findsOneWidget,
      );

      source.opened.add('/randevular/$bookingId');
      await tester.pumpAndSettle();
      expect(find.text('Onaylandı — ödeme bekleniyor'), findsWidgets);
    },
  );
}
