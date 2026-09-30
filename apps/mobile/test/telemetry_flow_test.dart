import 'package:emek_mobile/telemetry/geolocator_source.dart';
import 'package:emek_mobile/telemetry/telemetry_buffer.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_backend.dart';

Map<String, Object?> session(
  String status, {
  bool expected = true,
  int lastSequence = 12,
}) => {
  'sessionId': 'ss1',
  'bookingId': 'b1',
  'status': status,
  'acceptsTelemetry': status == 'ACTIVE' || status == 'ARRIVAL_MONITORING',
  'telemetryExpectedFromYou': expected,
  'telemetryIntervalSeconds': 30,
  'lastSequence': lastSequence,
  'emergencyActive': false,
  'panicRaisedAt': null,
  'closedAt': null,
};

Map<String, Object?> booking(String status) => {
  'id': 'b1',
  'customerId': 'c1',
  'providerId': 'u1',
  'serviceId': 's1',
  'addressId': 'a1',
  'scheduledStart': '2026-10-12T07:00:00Z',
  'scheduledEnd': '2026-10-12T10:00:00Z',
  'priceMinor': '96000',
  'currency': 'TRY',
  'status': status,
};

void tallSurface(WidgetTester tester) {
  tester.view.physicalSize = const Size(1200, 5000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
}

void main() {
  testWidgets(
    'sağlayıcı: oturum açılınca konum akışı başlar, sıra lastSequence’ten sürer',
    (tester) async {
      tallSurface(tester);
      final source = ScriptedLocationSource();
      final backend = FakeBackend({
        ...providerSession(),
        'GET /bookings': (_) => json([booking('IN_PROGRESS')]),
        'GET /bookings/b1/safety-session': (_) => json(session('ACTIVE')),
        'POST /safety/sessions/ss1/telemetry': (_) => json({
          'sessionId': 'ss1',
          'accepted': 1,
          'rejected': 0,
          'results': <Object>[],
          'telemetryIntervalSeconds': 30,
        }),
      });
      await pumpSignedInApp(
        tester,
        backend,
        location: '/panel',
        locationSource: source,
      );
      expect(source.starts, 1); // kabuk açılır açılmaz eşitlendi

      source.emit(
        LocationReading(
          capturedAt: DateTime.now().toUtc(),
          latitude: 40.99,
          longitude: 29.03,
          accuracyMeters: 9,
          isMock: true,
        ),
      );
      await tester.pump(const Duration(seconds: 31));
      await tester.pumpAndSettle();

      final sent = backend
          .callsTo('POST', '/safety/sessions/ss1/telemetry')
          .single;
      final sample = ((sent.body! as Map)['samples'] as List).single as Map;
      expect(sample['sequence'], 13);
      expect(sample['isMockLocation'], isTrue);
      expect(sent.idempotencyKey, isNull);
      await tester.pumpWidget(const SizedBox()); // motor ve zamanlayıcı kapanır
    },
  );

  testWidgets(
    'güvenlik ekranı: paylaşım açık kartı; izin reddedilirse kaynak hiç açılmaz',
    (tester) async {
      tallSurface(tester);
      final source = NoLocationSource();
      final backend = FakeBackend({
        ...providerSession(),
        'GET /bookings': (_) => json(<Object>[]),
        'GET /bookings/b1/safety-session': (_) => json(session('ACTIVE')),
      });
      await pumpSignedInApp(
        tester,
        backend,
        location: '/panel/randevular/b1/oturum',
        locationSource: source,
        locationAccess: LocationAccess.deniedForever,
      );
      // İlk eşitleme yoklama/yenilemeyle gelir.
      await tester.pump(const Duration(seconds: 31));
      await tester.pumpAndSettle();

      expect(source.starts, 0);
      expect(find.text('KONUM PAYLAŞIMI'), findsOneWidget);
      expect(find.textContaining('Ayarlardan'), findsOneWidget);
      expect(find.text('Ayarları aç'), findsOneWidget);
    },
  );

  testWidgets('hizmet bitince (aktif randevu kalmayınca) konum akışı durur', (
    tester,
  ) async {
    tallSurface(tester);
    var status = 'IN_PROGRESS';
    final source = NoLocationSource();
    final backend = FakeBackend({
      ...providerSession(),
      'GET /bookings': (_) => json([booking(status)]),
      'GET /bookings/b1/safety-session': (_) => json(
        session(
          status == 'IN_PROGRESS' ? 'ACTIVE' : 'CLOSED',
          expected: status == 'IN_PROGRESS',
        ),
      ),
      'GET /bookings/b1': (_) => json(booking(status)),
      'GET /bookings/b1/history': (_) => json(<Object>[]),
      'GET /bookings/b1/documents': (_) => json(<Object>[]),
      'POST /bookings/b1/transitions': (call) {
        status = 'CHECKED_OUT';
        return json(booking(status));
      },
    });
    await pumpSignedInApp(
      tester,
      backend,
      location: '/panel/randevular/b1',
      locationSource: source,
    );
    expect(source.starts, 1);

    await tester.tap(find.text('Hizmeti bitirdim'));
    await tester.pump();
    await tester.tap(find.text('Evet, hizmet bitti'));
    await tester.pumpAndSettle();
    expect(source.stops, greaterThanOrEqualTo(1));
  });

  testWidgets('müşteri: oturum aktifken bile konum toplanmaz', (tester) async {
    tallSurface(tester);
    final source = NoLocationSource();
    final backend = FakeBackend({
      'GET /bookings/b1/safety-session': (_) =>
          json(session('ACTIVE', expected: false)),
    });
    await pumpSignedInApp(
      tester,
      backend,
      location: '/randevular/b1/guvenlik',
      locationSource: source,
    );
    await tester.pump(const Duration(seconds: 31));
    await tester.pumpAndSettle();
    expect(source.starts, 0);
    expect(find.text('KONUM PAYLAŞIMI'), findsNothing);
  });

  testWidgets(
    'adres: “Konumumu kullan” koordinatı doldurur, kaydetmeden istek gitmez',
    (tester) async {
      tallSurface(tester);
      final backend = FakeBackend({'GET /addresses': (_) => json(<Object>[])});
      await pumpSignedInApp(
        tester,
        backend,
        currentLocation: (latitude: 41.0082, longitude: 28.9784),
      );
      await tester.tap(find.text('Konumumu kullan'));
      await tester.pumpAndSettle();
      expect(find.text('41.008200'), findsOneWidget);
      expect(find.text('28.978400'), findsOneWidget);
      expect(backend.callsTo('POST', '/addresses'), isEmpty);
    },
  );
}
