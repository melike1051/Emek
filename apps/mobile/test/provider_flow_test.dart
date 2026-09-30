import 'dart:convert';
import 'dart:typed_data';

import 'package:emek_mobile/api/provider_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_backend.dart';

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
    'panel: hazırlık eksikken başvuru kapalı; tamamlanınca gönderilir (kimlik hariç)',
    (tester) async {
      tallSurface(tester);
      var complete = false;
      var submitted = false;
      final backend = FakeBackend({
        ...providerSession(state: 'DRAFT'),
        'GET /providers/me': (_) => json({
          'userId': 'u1',
          'displayName': 'Hatice Y.',
          'bio': 'Deneyimliyim.',
          'experienceYears': null,
          'maxDailyBookings': 2,
          'state': submitted ? 'PENDING_REVIEW' : 'DRAFT',
        }),
        'GET /providers/me/services': (_) => json([
          {'serviceId': 's1', 'active': true},
        ]),
        'GET /providers/me/service-areas': (_) => json(
          complete
              ? [
                  {
                    'id': 'ar1',
                    'name': 'Kadıköy',
                    'radiusMeters': 5000,
                    'active': true,
                  },
                ]
              : <Object>[],
        ),
        'GET /providers/me/availability': (call) => json(
          complete
              ? [
                  {
                    'id': 'w1',
                    'startsAt': '2026-10-12T06:00:00Z',
                    'endsAt': '2026-10-12T14:00:00Z',
                  },
                ]
              : <Object>[],
        ),
        'GET /verification/status': (_) => json({'identityVerified': false}),
        'GET /bookings': (_) => json(<Object>[]),
        'POST /providers/me/submit': (_) {
          submitted = true;
          return json({}, 201);
        },
      });
      await pumpSignedInApp(tester, backend, location: '/panel');

      expect(find.text('Taslak'), findsOneWidget);
      expect(find.text('Eksik'), findsNWidgets(3)); // bölge, müsaitlik, kimlik
      final submit = find.widgetWithText(
        FilledButton,
        'Başvuruyu incelemeye gönder',
      );
      expect(tester.widget<FilledButton>(submit).onPressed, isNull);
      expect(find.textContaining('Kimliği doğrulanmamış'), findsOneWidget);

      // Müsaitlik sorgusu aralık ister (backend aralıksız listeyi reddeder).
      final availability = backend
          .callsTo('GET', '/providers/me/availability')
          .first;
      expect(availability.path, '/providers/me/availability');

      complete = true;
      await tester.pumpWidget(const SizedBox());
      await pumpSignedInApp(tester, backend, location: '/panel');
      expect(find.text('Eksik'), findsOneWidget); // yalnız kimlik
      await tester.tap(find.text('Başvuruyu incelemeye gönder'));
      await tester.pumpAndSettle();
      expect(backend.callsTo('POST', '/providers/me/submit'), hasLength(1));
      expect(find.text('İncelemede'), findsOneWidget);
    },
  );

  testWidgets(
    'randevu: kabul (anahtarlı) → yola çıktım → vardım; ret gerekçeli iptaldir',
    (tester) async {
      tallSurface(tester);
      var status = 'PROVIDER_PENDING';
      final backend = FakeBackend({
        ...providerSession(),
        'GET /bookings/b1': (_) => json(booking(status)),
        'GET /bookings/b1/history': (_) => json(<Object>[]),
        'GET /bookings/b1/documents': (_) => json(<Object>[]),
        'POST /bookings/b1/confirm': (_) {
          status = 'CONFIRMED';
          return json(booking(status));
        },
        'POST /bookings/b1/transitions': (call) {
          status = (call.body! as Map)['to'] as String;
          return json(booking(status));
        },
      });
      await pumpSignedInApp(tester, backend, location: '/panel/randevular/b1');

      expect(find.text('Yanıtınız bekleniyor'), findsOneWidget);
      await tester.tap(find.text('Randevuyu kabul et'));
      await tester.pump();
      await tester.tap(find.text('Evet, kabul ediyorum'));
      await tester.pumpAndSettle();
      expect(
        backend.callsTo('POST', '/bookings/b1/confirm').single.idempotencyKey,
        isNotNull,
      );
      expect(find.text('Müşteri ödemesi bekleniyor'), findsOneWidget);

      status = 'SCHEDULED';
      await tester.pumpWidget(const SizedBox());
      await pumpSignedInApp(tester, backend, location: '/panel/randevular/b1');
      await tester.tap(find.text('Yola çıktım'));
      await tester.pump();
      await tester.tap(find.text('Evet, yola çıkıyorum'));
      await tester.pumpAndSettle();
      // Sonraki adımın onayı sıfırdan başlar (iki adımlı).
      expect(find.text('Adrese vardım'), findsOneWidget);
      expect(find.text('Evet, adresteyim'), findsNothing);
      await tester.tap(find.text('Adrese vardım'));
      await tester.pump();
      await tester.tap(find.text('Evet, adresteyim'));
      await tester.pumpAndSettle();

      final transitions = backend.callsTo('POST', '/bookings/b1/transitions');
      expect(transitions.map((c) => c.body), [
        {'to': 'PROVIDER_ARRIVING'},
        {'to': 'CHECKED_IN'},
      ]);
      expect(
        transitions[0].idempotencyKey,
        isNot(transitions[1].idempotencyKey),
      );
      expect(find.text('Adrestesiniz'), findsOneWidget);
    },
  );

  testWidgets(
    'hizmet adresi: ödemeden önce istenmez, planlanınca gösterilir (R-102)',
    (tester) async {
      tallSurface(tester);
      var status = 'CONFIRMED';
      final backend = FakeBackend({
        ...providerSession(),
        'GET /bookings/b1': (_) => json(booking(status)),
        'GET /bookings/b1/history': (_) => json(<Object>[]),
        'GET /bookings/b1/documents': (_) => json(<Object>[]),
        'GET /bookings/b1/address': (_) => json({
          'city': 'Ankara',
          'district': 'Çankaya',
          'line': 'Atatürk Blv. No 1',
          'latitude': 39.92,
          'longitude': 32.85,
        }),
      });
      await pumpSignedInApp(tester, backend, location: '/panel/randevular/b1');
      expect(
        find.text(
          'Hizmet adresi, müşteri ödemeyi onaylayıp randevu planlandığında görünür.',
        ),
        findsOneWidget,
      );
      expect(backend.callsTo('GET', '/bookings/b1/address'), isEmpty);

      status = 'SCHEDULED';
      await pumpSignedInApp(tester, backend, location: '/panel/randevular/b1');
      expect(find.text('Atatürk Blv. No 1'), findsOneWidget);
      expect(find.text('Çankaya / Ankara'), findsOneWidget);
      expect(find.text('Haritada aç'), findsOneWidget);
      expect(backend.callsTo('GET', '/bookings/b1/address'), hasLength(1));
    },
  );

  testWidgets('ret: PROVIDER_PENDING’de gerekçeli cancel', (tester) async {
    tallSurface(tester);
    final backend = FakeBackend({
      ...providerSession(),
      'GET /bookings/b1': (_) => json(booking('PROVIDER_PENDING')),
      'GET /bookings/b1/history': (_) => json(<Object>[]),
      'GET /bookings/b1/documents': (_) => json(<Object>[]),
      'POST /bookings/b1/cancel': (_) => json(booking('CANCELLED')),
    });
    await pumpSignedInApp(tester, backend, location: '/panel/randevular/b1');
    await tester.tap(find.text('Reddet'));
    await tester.pump();
    await tester.enterText(
      find.byType(TextField).first,
      'O saatte başka işim var',
    );
    await tester.tap(find.text('Randevuyu reddet'));
    await tester.pumpAndSettle();
    expect(backend.callsTo('POST', '/bookings/b1/cancel').single.body, {
      'reason': 'O saatte başka işim var',
    });
  });

  testWidgets(
    'kanıt: kayıt → imzalı URL’e kimliksiz PUT → SHA-256 onay; ağ hatasında aynı kayıt',
    (tester) async {
      tallSurface(tester);
      final photo = Uint8List.fromList(utf8.encode('fake-jpeg-bytes'));
      var putAttempts = 0;
      var confirmed = false;
      final backend = FakeBackend({
        ...providerSession(),
        'GET /bookings/b1': (_) => json(booking('CHECKED_IN')),
        'GET /bookings/b1/history': (_) => json(<Object>[]),
        'GET /bookings/b1/address': (_) => json({
          'city': 'Ankara',
          'district': 'Çankaya',
          'line': 'Atatürk Blv. No 1',
          'latitude': 39.92,
          'longitude': 32.85,
        }),
        'GET /bookings/b1/documents': (_) => json(
          confirmed
              ? [
                  {
                    'id': 'd1',
                    'documentType': 'BEFORE_PHOTO',
                    'status': 'AVAILABLE',
                    'sha256': 'f' * 64,
                    'createdAt': '2026-10-12T07:05:00Z',
                  },
                ]
              : <Object>[],
        ),
        'POST /documents': (_) => json({
          'document': {'id': 'd1'},
          'uploadUrl': '/api/v1/_dev/storage/d1?sig=abc',
          'expiresAt': '2026-10-12T07:20:00Z',
        }, 201),
        'PUT /_dev/storage/d1': (_) => ++putAttempts == 1
            ? apiError(503, 'SERVICE_UNAVAILABLE', 'Geçici.')
            : json({}),
        'POST /documents/d1/confirm': (_) {
          confirmed = true;
          return json({
            'id': 'd1',
            'documentType': 'BEFORE_PHOTO',
            'status': 'AVAILABLE',
            'sha256': 'f' * 64,
            'createdAt': '2026-10-12T07:05:00Z',
          });
        },
      });
      await pumpSignedInApp(
        tester,
        backend,
        location: '/panel/randevular/b1',
        picker: (_) async => (bytes: photo, contentType: 'image/jpeg'),
      );

      await tester.tap(find.text('Galeriden'));
      await tester.pumpAndSettle();
      expect(
        find.text('Dosya yüklenemedi. Lütfen tekrar deneyin.'),
        findsOneWidget,
      );
      await tester.tap(find.text('Tekrar dene'));
      await tester.pumpAndSettle();

      expect(
        backend.callsTo('POST', '/documents'),
        hasLength(1),
      ); // yeni kayıt açılmadı
      final puts = backend.callsTo('PUT', '/_dev/storage/d1');
      expect(puts, hasLength(2));
      expect(puts.last.headers['authorization'], isNull);
      expect(puts.last.headers['content-type'], 'image/jpeg');
      // Özet dosyanın kendisinden hesaplanır; backend storage'daki nesneyle karşılaştırır.
      expect(backend.callsTo('POST', '/documents/d1/confirm').single.body, {
        'sha256': sha256Hex(photo),
      });
      expect(find.text('Önce'), findsOneWidget);
    },
  );
}
