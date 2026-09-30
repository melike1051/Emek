import 'dart:convert';

import 'package:emek_mobile/api/api_client.dart';
import 'package:emek_mobile/api/api_error.dart';
import 'package:emek_mobile/api/idempotency_key.dart';
import 'package:emek_mobile/auth/auth_adapter.dart';
import 'package:emek_mobile/auth/phone.dart';
import 'package:emek_mobile/config/env.dart';
import 'package:emek_mobile/router.dart';
import 'package:emek_mobile/session/session.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  group('AppEnv', () {
    const local = {'AUTH_MODE': 'mock', 'API_BASE_URL': 'http://10.0.2.2:3000'};

    test('mock + yerel http debug build’de kabul', () {
      final env = AppEnv.parse(local, isRelease: false);
      expect(env.authMode, AuthMode.mock);
      expect(env.apiBaseUrl.host, '10.0.2.2');
    });

    test('mock release build’de reddedilir', () {
      expect(() => AppEnv.parse(local, isRelease: true), throwsStateError);
    });

    test('release https ister; firebase modu yapılandırma ister', () {
      expect(
        () => AppEnv.parse({
          'AUTH_MODE': 'firebase',
          'API_BASE_URL': 'http://api.example',
        }, isRelease: true),
        throwsStateError,
      );
      expect(
        () => AppEnv.parse({
          'API_BASE_URL': 'https://api.example',
        }, isRelease: true),
        throwsStateError,
      );
    });

    test('API_BASE_URL mutlak olmalı', () {
      expect(
        () => AppEnv.parse({
          'AUTH_MODE': 'mock',
          'API_BASE_URL': '/api',
        }, isRelease: false),
        throwsStateError,
      );
    });
  });

  group('ApiClient', () {
    late http.BaseRequest captured;

    ApiClient client(
      http.Response Function(http.BaseRequest) respond, {
      String? appCheck,
    }) => ApiClient(
      baseUrl: Uri.parse('http://localhost:3000/'),
      idToken: () async => 'mock:u1',
      appCheckToken: () async => appCheck,
      httpClient: MockClient((request) async {
        captured = request;
        return respond(request);
      }),
    );

    test(
      'kimlik, App Check, Idempotency-Key ve JSON gövdesi gönderir',
      () async {
        final api = client(
          (_) => http.Response('{"ok":true}', 201),
          appCheck: 'ac-1',
        );
        final result = await api.post(
          '/bookings/b 1/confirm',
          body: {'a': 1},
          idempotencyKey: 'k-1',
        );

        expect(result, {'ok': true});
        expect(
          captured.url.toString(),
          'http://localhost:3000/api/v1/bookings/b%201/confirm',
        );
        expect(captured.headers['Authorization'], 'Bearer mock:u1');
        expect(captured.headers['X-Firebase-AppCheck'], 'ac-1');
        expect(captured.headers['Idempotency-Key'], 'k-1');
        expect(jsonDecode((captured as http.Request).body), {'a': 1});
      },
    );

    test(
      'App Check yoksa başlık gönderilmez; boş sorgu parametreleri atlanır',
      () async {
        final api = client((_) => http.Response('[]', 200));
        await api.get(
          '/bookings',
          query: {'status': 'OPEN', 'cursor': null, 'q': ''},
        );
        expect(captured.headers.containsKey('X-Firebase-AppCheck'), isFalse);
        expect(captured.url.query, 'status=OPEN');
      },
    );

    test(
      'backend hata gövdesi ApiError olur; mesaj ve referans korunur',
      () async {
        final api = client(
          (_) => http.Response(
            jsonEncode({
              'error': {
                'code': 'BOOKING_NOT_FOUND',
                'message': 'Randevu bulunamadı.',
                'requestId': 'r-1',
              },
            }),
            404,
            headers: {'content-type': 'application/json; charset=utf-8'},
          ),
        );
        await expectLater(
          api.get('/bookings/x'),
          throwsA(
            isA<ApiError>()
                .having((e) => e.code, 'code', 'BOOKING_NOT_FOUND')
                .having((e) => e.requestId, 'requestId', 'r-1')
                .having((e) => e.isAmbiguous, 'isAmbiguous', isFalse),
          ),
        );
      },
    );

    test(
      'sözleşme dışı 5xx belirsizdir; ağ hatası NETWORK_ERROR olur',
      () async {
        await expectLater(
          client((_) => http.Response('<html>', 502)).get('/x'),
          throwsA(
            isA<ApiError>()
                .having((e) => e.code, 'code', ApiError.unexpectedCode)
                .having((e) => e.isAmbiguous, 'isAmbiguous', isTrue),
          ),
        );
        final offline = ApiClient(
          baseUrl: Uri.parse('http://localhost:3000'),
          idToken: () async => null,
          httpClient: MockClient((_) => throw http.ClientException('offline')),
        );
        await expectLater(
          offline.get('/x'),
          throwsA(
            isA<ApiError>().having((e) => e.code, 'code', ApiError.networkCode),
          ),
        );
      },
    );

    test('yol / ile başlamalı', () {
      expect(
        () => client((_) => http.Response('', 204)).buildUri('bookings'),
        throwsArgumentError,
      );
    });
  });

  test(
    'IdempotencyKey: aynı gövde aynı anahtar, değişen gövde yeni, rotate yeni',
    () {
      var n = 0;
      final key = IdempotencyKey(generate: () => 'k${n++}');
      expect(key.current('{"rating":4}'), 'k0');
      expect(key.current('{"rating":4}'), 'k0');
      expect(key.current('{"rating":5}'), 'k1');
      key.rotate();
      expect(key.current('{"rating":5}'), 'k2');
    },
  );

  test('normalizeTrPhone web ile aynı kuralları uygular', () {
    for (final ok in [
      '0532 111 22 33',
      '532 111 2233',
      '+90 532 111 22 33',
      '905321112233',
    ]) {
      expect(normalizeTrPhone(ok), '+905321112233', reason: ok);
    }
    for (final bad in ['123', '0212 111 22 33', '00905321112233', '']) {
      expect(normalizeTrPhone(bad), isNull, reason: bad);
    }
  });

  test(
    'MockAuthAdapter backend token biçimini üretir ve geçersiz kimliği reddeder',
    () {
      expect(
        MockAuthAdapter.buildToken(' dev-1 ', '+905321112233'),
        'mock:dev-1:phone=+905321112233',
      );
      expect(
        () => MockAuthAdapter.buildToken('a:b', null),
        throwsFormatException,
      );
    },
  );

  group('sessionRedirect', () {
    const customer = Session(
      userId: 'u1',
      roles: ['CUSTOMER'],
      customer: CustomerProfile(userId: 'u1', displayName: 'A'),
      provider: null,
    );
    const empty = Session(
      userId: 'u1',
      roles: [],
      customer: null,
      provider: null,
    );

    String? go(bool? signedIn, Session? session, String location) =>
        sessionRedirect(
          signedIn: signedIn,
          session: AsyncValue.data(session),
          location: location,
        );

    test('oturumsuz her yer girişe', () {
      expect(go(false, null, '/panel'), '/giris');
      expect(go(null, null, '/'), '/giris');
      expect(go(false, null, '/giris'), isNull);
    });

    test('profil yoksa rol seçimi; varsa girişten ana sayfaya', () {
      expect(go(true, empty, '/'), '/rol-sec');
      expect(go(true, empty, '/rol-sec'), isNull);
      expect(go(true, customer, '/giris'), '/');
      expect(go(true, customer, '/rol-sec'), isNull);
    });

    test('sağlayıcı profili olmadan panel yok', () {
      expect(go(true, customer, '/panel'), '/');
    });

    test('oturum kurulurken girişte beklenir', () {
      expect(
        sessionRedirect(
          signedIn: true,
          session: const AsyncValue<Session?>.loading(),
          location: '/',
        ),
        '/giris',
      );
    });
  });
}
