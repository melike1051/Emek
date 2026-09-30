import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_backend.dart';

Map<String, Object?> booking(String status) => {
  'id': 'b1',
  'customerId': 'u1',
  'providerId': 'p1',
  'serviceId': 's1',
  'addressId': 'a1',
  'scheduledStart': '2026-10-12T07:00:00Z',
  'scheduledEnd': '2026-10-12T10:00:00Z',
  'priceMinor': '96000',
  'currency': 'TRY',
  'status': status,
};

Map<String, Object?> session(String status, {bool emergency = false}) => {
  'sessionId': 'ss1',
  'bookingId': 'b1',
  'status': status,
  'acceptsTelemetry': true,
  'telemetryExpectedFromYou': false,
  'telemetryIntervalSeconds': 60,
  'lastSequence': 0,
  'emergencyActive': emergency,
  'panicRaisedAt': emergency ? '2026-10-12T08:00:00Z' : null,
  'closedAt': null,
};

/// Backend `MatchResultResponseDto` — POST ve GET aynı gövdeyi döner.
const matched = {
  'requestId': 'r1',
  'runId': 'run1',
  'status': 'MATCHED',
  'degraded': false,
  'bookingId': 'b1',
  'providerId': 'p1',
  'providerName': 'Hatice Y.',
  'scheduledStart': '2026-10-12T07:00:00Z',
  'scheduledEnd': '2026-10-12T10:00:00Z',
  'explanation': [
    {'code': 'NEARBY', 'value': 2.2},
    {'code': 'UNKNOWN_FUTURE_CODE', 'value': null},
  ],
};

/// Uzun ekranlar tembel kurulan listede kalmasın diye büyük bir test yüzeyi.
void tallSurface(WidgetTester tester) {
  tester.view.physicalSize = const Size(1200, 5000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
}

void main() {
  testWidgets(
    'doğal dil talebi → özet → eşleştir (Idempotency-Key) → sonuç → randevu → ödeme',
    (tester) async {
      tallSurface(tester);
      var status = 'PROVIDER_PENDING';
      var paid = false;
      final backend = FakeBackend({
        'POST /booking-requests/from-text': (_) => json({
          'status': 'CREATED',
          'request': {
            'id': 'r1',
            'serviceId': 's1',
            'addressId': 'a1',
            'preferredStart': '2026-10-12T06:00:00Z',
            'preferredEnd': '2026-10-12T15:00:00Z',
            'durationMinutes': 180,
            'parserVersion': 'rule-tr-v3',
            'parserConfidence': 0.72,
          },
          'clarifications': <Object>[],
        }, 201),
        'GET /booking-requests/r1': (_) => json({
          'id': 'r1',
          'serviceId': 's1',
          'addressId': 'a1',
          'preferredStart': '2026-10-12T06:00:00Z',
          'preferredEnd': '2026-10-12T15:00:00Z',
          'durationMinutes': 180,
          'parserVersion': 'rule-tr-v3',
          'parserConfidence': 0.72,
        }),
        'POST /booking-requests/r1/match': (_) => json(matched, 201),
        'GET /booking-requests/r1/match': (_) => json(matched),
        'GET /bookings/b1': (_) => json(booking(status)),
        'GET /bookings/b1/history': (_) => json(<Object>[]),
        'GET /bookings/b1/disputes': (_) => json(<Object>[]),
        'GET /bookings/b1/payment': (_) => paid
            ? json({
                'id': 'pay1',
                'bookingId': 'b1',
                'amountMinor': '96000',
                'currency': 'TRY',
                'refundedMinor': '0',
                'status': 'HELD',
                'authorizationExpiresAt': null,
                'releasedAt': null,
              })
            : apiError(404, 'NOT_FOUND', 'Kaynak bulunamadı.'),
        'POST /bookings/b1/payment': (_) {
          paid = true;
          status = 'SCHEDULED';
          return json({'paymentId': 'pay1', 'status': 'HELD'}, 201);
        },
      });
      await pumpSignedInApp(tester, backend);

      await tester.enterText(
        find.byKey(const Key('explore.text')),
        'Yarın sabah 3 saat temizlik',
      );
      await tester.pump();
      await tester.tap(find.text('Uygun sağlayıcıyı bul'));
      await tester.pumpAndSettle();
      expect(
        backend.callsTo('POST', '/booking-requests/from-text').single.body,
        {'rawText': 'Yarın sabah 3 saat temizlik', 'addressId': 'a1'},
      );

      // Özet: düşük güven uyarısı, İstanbul saatiyle aralık.
      expect(find.textContaining('emin değiliz'), findsOneWidget);
      expect(find.text('12 Eki 2026 09:00 – 18:00'), findsOneWidget);
      await tester.tap(find.text('Sağlayıcı bul'));
      await tester.pumpAndSettle();
      expect(
        backend
            .callsTo('POST', '/booking-requests/r1/match')
            .single
            .idempotencyKey,
        isNotNull,
      );

      // Sonuç: gerekçe Türkçe, bilinmeyen kod gösterilmez.
      expect(find.text('Hatice Y.'), findsOneWidget);
      expect(find.text('Yaklaşık 2 km uzaklıkta'), findsOneWidget);
      expect(find.textContaining('UNKNOWN'), findsNothing);
      await tester.tap(find.text('Randevuya git'));
      await tester.pumpAndSettle();
      expect(find.text('Sağlayıcı onayı bekleniyor'), findsWidgets);
      expect(find.textContaining('ödemeyi onayla'), findsNothing);

      // Sağlayıcı onayladı → ödeme; gövde boş, anahtar var.
      status = 'CONFIRMED';
      // Aşağı çekerek yenile (sağlayıcı başka cihazda onayladı).
      // Aşağı çekerek yenileme; `show()` onRefresh'i çalıştırır (future'ı kare pompalanınca
      // tamamlanır — beklenmez).
      unawaited(
        tester
            .state<RefreshIndicatorState>(find.byType(RefreshIndicator))
            .show(),
      );
      await tester.pumpAndSettle();
      await tester.pumpAndSettle();
      expect(find.text('960,00 ₺ ödemeyi onayla'), findsOneWidget);
      await tester.tap(find.text('960,00 ₺ ödemeyi onayla'));
      await tester.pumpAndSettle();
      final pay = backend.callsTo('POST', '/bookings/b1/payment').single;
      expect(pay.body, isNull);
      expect(pay.idempotencyKey, isNotNull);
      expect(find.text('Güvende tutuluyor'), findsOneWidget);
      expect(find.text('Planlandı'), findsWidgets);
    },
  );

  testWidgets(
    'netleştirme seçeneği metne eklenir; AI kapalıysa (FORM_REQUIRED) form açılır',
    (tester) async {
      tallSurface(tester);
      var formRequired = false;
      final backend = FakeBackend({
        'POST /booking-requests/from-text': (_) => formRequired
            ? json({
                'status': 'FORM_REQUIRED',
                'request': null,
                'clarifications': <Object>[],
              })
            : json({
                'status': 'NEEDS_CLARIFICATION',
                'request': null,
                'clarifications': [
                  {
                    'field': 'duration',
                    'question': 'Kaç saat sürsün?',
                    'options': ['3 saat', '4 saat'],
                  },
                ],
              }),
      });
      await pumpSignedInApp(tester, backend);

      await tester.enterText(find.byKey(const Key('explore.text')), 'Temizlik');
      await tester.pump();
      await tester.tap(find.text('Uygun sağlayıcıyı bul'));
      await tester.pumpAndSettle();
      expect(find.text('Kaç saat sürsün?'), findsOneWidget);
      await tester.tap(find.text('4 saat'));
      await tester.pump();
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('explore.text')))
            .controller!
            .text,
        'Temizlik 4 saat',
      );

      formRequired = true;
      await tester.tap(find.text('Uygun sağlayıcıyı bul'));
      await tester.pumpAndSettle();
      expect(
        find.textContaining('Akıllı talep şu an kullanılamıyor'),
        findsOneWidget,
      );
      expect(find.text('Talebi oluştur'), findsOneWidget);
    },
  );

  testWidgets(
    'eşleştirme belirsiz hatadan sonra aynı anahtarla; zaten eşleşmişse sonuca gider',
    (tester) async {
      var attempt = 0;
      final backend = FakeBackend({
        'GET /booking-requests/r1': (_) => json({
          'id': 'r1',
          'serviceId': 's1',
          'addressId': 'a1',
          'preferredStart': '2026-10-12T06:00:00Z',
          'preferredEnd': '2026-10-12T15:00:00Z',
          'durationMinutes': 180,
          'parserVersion': null,
          'parserConfidence': null,
        }),
        'POST /booking-requests/r1/match': (_) => ++attempt == 1
            ? apiError(
                503,
                'SERVICE_UNAVAILABLE',
                'Hizmet geçici olarak kullanılamıyor.',
              )
            : apiError(
                409,
                'MATCHING_ALREADY_COMPLETED',
                'Zaten eşleştirildi.',
              ),
        'GET /booking-requests/r1/match': (_) => json({
          'requestId': 'r1',
          'runId': 'run1',
          'status': 'NO_CANDIDATE',
          'degraded': true,
          'bookingId': null,
          'providerId': null,
          'providerName': null,
          'scheduledStart': null,
          'scheduledEnd': null,
          'explanation': <Object>[],
        }),
      });
      await pumpSignedInApp(tester, backend, location: '/talep/r1');

      expect(find.textContaining('emin değiliz'), findsNothing);
      await tester.tap(find.text('Sağlayıcı bul'));
      await tester.pumpAndSettle();
      expect(find.text('Hizmet geçici olarak kullanılamıyor.'), findsOneWidget);
      await tester.tap(find.text('Sağlayıcı bul'));
      await tester.pumpAndSettle();

      final keys = backend
          .callsTo('POST', '/booking-requests/r1/match')
          .map((c) => c.idempotencyKey);
      expect(keys.toSet(), hasLength(1));
      expect(find.text('Şu an uygun sağlayıcı bulamadık'), findsOneWidget);
    },
  );

  testWidgets(
    'değerlendirme: aynı gövde aynı anahtar, değişen puan yeni anahtar',
    (tester) async {
      tallSurface(tester);
      var attempt = 0;
      final backend = FakeBackend({
        'GET /bookings/b1': (_) => json(booking('COMPLETED')),
        'GET /bookings/b1/history': (_) => json(<Object>[]),
        'GET /bookings/b1/disputes': (_) => json(<Object>[]),
        'GET /bookings/b1/payment': (_) => apiError(404, 'NOT_FOUND', 'Yok.'),
        'POST /bookings/b1/review': (_) => ++attempt < 3
            ? apiError(503, 'SERVICE_UNAVAILABLE', 'Geçici hata.')
            : json({'id': 'rev1'}, 201),
      });
      await pumpSignedInApp(tester, backend, location: '/randevular/b1');

      await tester.tap(find.byTooltip('4 yıldız'));
      await tester.pump();
      await tester.tap(find.text('Değerlendirmeyi gönder'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Değerlendirmeyi gönder'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('5 yıldız'));
      await tester.pump();
      await tester.tap(find.text('Değerlendirmeyi gönder'));
      await tester.pumpAndSettle();

      final calls = backend.callsTo('POST', '/bookings/b1/review');
      expect(calls.map((c) => c.body), [
        {'rating': 4},
        {'rating': 4},
        {'rating': 5},
      ]);
      expect(calls[1].idempotencyKey, calls[0].idempotencyKey);
      expect(calls[2].idempotencyKey, isNot(calls[0].idempotencyKey));
      expect(find.text('Değerlendirmeniz için teşekkürler.'), findsOneWidget);
    },
  );

  testWidgets(
    'güvenlik: PRE_SERVICE’te panik yok (112 yolu); ACTIVE’de panik anahtarsız gider',
    (tester) async {
      tallSurface(tester);
      var status = 'PRE_SERVICE';
      var raised = false;
      final backend = FakeBackend({
        'GET /bookings/b1/safety-session': (_) =>
            json(session(status, emergency: raised)),
        'POST /safety/sessions/ss1/panic': (_) {
          raised = true;
          return json({
            'sessionId': 'ss1',
            'eventId': 'e1',
            'raisedAt': '2026-10-12T08:00:00Z',
            'duplicate': false,
            'bookingHoldApplied': true,
          }, 201);
        },
      });
      await pumpSignedInApp(
        tester,
        backend,
        location: '/randevular/b1/guvenlik',
      );

      expect(find.text('Hizmet saatinde başlayacak'), findsOneWidget);
      expect(find.text('ACİL DURUM'), findsOneWidget); // yalnız bölüm başlığı
      expect(find.widgetWithText(FilledButton, 'Acil durum'), findsNothing);
      expect(find.text('112’yi ara'), findsOneWidget);

      status = 'ACTIVE';
      await tester.pumpWidget(
        const SizedBox(),
      ); // ekranı yeniden kur (yoklamayı beklemeden)
      await pumpSignedInApp(
        tester,
        backend,
        location: '/randevular/b1/guvenlik',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Acil durum'));
      await tester.pump();
      await tester.tap(find.text('Sağlık'));
      await tester.pump();
      await tester.tap(find.text('Evet, acil durum bildir'));
      await tester.pumpAndSettle();

      final panic = backend
          .callsTo('POST', '/safety/sessions/ss1/panic')
          .single;
      expect(panic.idempotencyKey, isNull);
      expect(panic.body, {'category': 'HEALTH'});
      expect(find.text('Acil durum kaydınız alındı'), findsOneWidget);
    },
  );

  testWidgets('güvenlik yoklaması yalnız ön planda; dönüşte hemen tazelenir', (
    tester,
  ) async {
    final backend = FakeBackend({
      'GET /bookings/b1/safety-session': (_) => json(session('ACTIVE')),
    });
    await pumpSignedInApp(tester, backend, location: '/randevular/b1/guvenlik');
    int reads() => backend.callsTo('GET', '/bookings/b1/safety-session').length;
    final initial = reads();

    await tester.pump(const Duration(seconds: 31));
    await tester.pumpAndSettle();
    expect(reads(), initial + 1);

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump(const Duration(seconds: 95));
    await tester.pumpAndSettle();
    expect(reads(), initial + 1, reason: 'arka planda yoklama yok');

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();
    expect(reads(), initial + 2, reason: 'dönüşte beklemeden tazelenir');
  });

  testWidgets('oturum henüz yoksa bilgi + 112; panik butonu yok', (
    tester,
  ) async {
    final backend = FakeBackend({
      'GET /bookings/b1/safety-session': (_) =>
          apiError(404, 'SAFETY_SESSION_NOT_FOUND', 'Oturum bulunamadı.'),
    });
    await pumpSignedInApp(tester, backend, location: '/randevular/b1/guvenlik');
    expect(find.text('Güvenlik oturumu henüz başlamadı'), findsOneWidget);
    expect(find.text('112’yi ara'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Acil durum'), findsNothing);
  });

  testWidgets(
    'randevular: yalnız müşteri olarak alınanlar; aktif/geçmiş ayrımı',
    (tester) async {
      final backend = FakeBackend({
        'GET /bookings': (_) => json([
          {...booking('SCHEDULED'), 'id': 'b1'},
          {...booking('SETTLED'), 'id': 'b2'},
          // Aynı kullanıcı bu randevuda sağlayıcı: müşteri listesinde görünmez.
          {
            ...booking('PROVIDER_PENDING'),
            'id': 'b3',
            'customerId': 'other',
            'providerId': 'u1',
          },
        ]),
      });
      await pumpSignedInApp(tester, backend, location: '/randevular');
      expect(find.text('Planlandı'), findsOneWidget);
      expect(find.text('Kapandı'), findsOneWidget);
      expect(find.text('Sağlayıcı onayı bekleniyor'), findsNothing);
      expect(find.text('Aktif'), findsOneWidget);
      expect(find.text('Geçmiş'), findsOneWidget);
    },
  );
}
