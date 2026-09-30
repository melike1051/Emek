import 'dart:convert';

import 'package:emek_mobile/api/api_client.dart';
import 'package:emek_mobile/auth/auth_adapter.dart';
import 'package:emek_mobile/config/env.dart';
import 'package:emek_mobile/main.dart';
import 'package:emek_mobile/session/providers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// Sahte backend: yalnız bu akışın uçları; profil oluşturulunca `/customers/me` döner.
class _Backend {
  bool customerCreated = false;
  final calls = <String>[];
  String? lastAuthorization;

  http.Client client() => MockClient((request) async {
    calls.add('${request.method} ${request.url.path}');
    lastAuthorization = request.headers['Authorization'];
    http.Response json(Object body, [int status = 200]) => http.Response(
      jsonEncode(body),
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );
    switch ('${request.method} ${request.url.path}') {
      case 'POST /api/v1/auth/session':
        return json({
          'userId': 'u1',
          'roles': ['CUSTOMER'],
        }, 201);
      case 'GET /api/v1/customers/me':
        return customerCreated
            ? json({'userId': 'u1', 'displayName': 'Ayşe K.'})
            : json({
                'error': {
                  'code': 'PROFILE_NOT_FOUND',
                  'message': 'Profil yok.',
                },
              }, 404);
      case 'POST /api/v1/customers/profile':
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        if ((body['displayName'] as String).length < 2) {
          return json({
            'error': {'code': 'VALIDATION_FAILED', 'message': 'Geçersiz.'},
          }, 422);
        }
        customerCreated = true;
        return json({'userId': 'u1', 'displayName': body['displayName']}, 201);
    }
    return json({
      'error': {'code': 'NOT_FOUND', 'message': 'Yok.'},
    }, 404);
  });
}

void main() {
  testWidgets(
    'mock giriş → rol seçimi → müşteri profili → keşfet; çıkış girişe döner',
    (tester) async {
      final backend = _Backend();
      final auth = MockAuthAdapter();
      final env = AppEnv(
        apiBaseUrl: Uri.parse('http://localhost:3000'),
        authMode: AuthMode.mock,
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            envProvider.overrideWithValue(env),
            authAdapterProvider.overrideWithValue(auth),
            apiClientProvider.overrideWithValue(
              ApiClient(
                baseUrl: env.apiBaseUrl,
                idToken: auth.idToken,
                httpClient: backend.client(),
              ),
            ),
          ],
          child: const EmekApp(),
        ),
      );
      await tester.pumpAndSettle();

      // Geçersiz telefon istemcide reddedilir, istek gitmez.
      expect(find.text("Emek'e hoş geldiniz"), findsOneWidget);
      await tester.enterText(
        find.byKey(const Key('login.subject')),
        'dev-ayse',
      );
      await tester.enterText(find.byKey(const Key('login.phone')), '123');
      await tester.tap(find.text('Giriş yap'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Geçerli bir cep telefonu'), findsOneWidget);
      expect(backend.calls, isEmpty);

      await tester.enterText(
        find.byKey(const Key('login.phone')),
        '0532 111 22 33',
      );
      await tester.tap(find.text('Giriş yap'));
      await tester.pumpAndSettle();
      expect(
        backend.lastAuthorization,
        'Bearer mock:dev-ayse:phone=+905321112233',
      );
      expect(find.text("Emek'te nasıl yer almak istersiniz?"), findsOneWidget);
      // Rolü olmayana /providers/me sorulmaz (403 olurdu).
      expect(backend.calls, isNot(contains('GET /api/v1/providers/me')));

      await tester.tap(find.text('Hizmet almak istiyorum'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('role.name')), 'A');
      await tester.tap(find.text('Devam et'));
      await tester.pumpAndSettle();
      expect(find.text('Ad 2–120 karakter olmalı.'), findsOneWidget);
      expect(backend.calls, isNot(contains('POST /api/v1/customers/profile')));

      await tester.enterText(find.byKey(const Key('role.name')), 'Ayşe K.');
      await tester.tap(find.text('Devam et'));
      await tester.pumpAndSettle();
      expect(
        find.text('Eviniz ve sevdikleriniz için güvenilir eller.'),
        findsOneWidget,
      );

      await tester.tap(find.byTooltip('Çıkış yap'));
      await tester.pumpAndSettle();
      expect(find.text("Emek'e hoş geldiniz"), findsOneWidget);
    },
  );
}
