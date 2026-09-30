import 'dart:async';
import 'dart:convert';

import 'package:emek_mobile/api/api_client.dart';
import 'package:emek_mobile/api/provider_api.dart';
import 'package:emek_mobile/telemetry/geolocator_source.dart';
import 'package:emek_mobile/telemetry/telemetry_buffer.dart';
import 'package:emek_mobile/telemetry/telemetry_controller.dart';
import 'package:emek_mobile/telemetry/telemetry_engine.dart';
import 'package:emek_mobile/features/provider/provider_bookings.dart';
import 'package:emek_mobile/features/provider/provider_providers.dart';
import 'package:emek_mobile/auth/auth_adapter.dart';
import 'package:emek_mobile/config/env.dart';
import 'package:emek_mobile/main.dart';
import 'package:emek_mobile/push/push_registrar.dart';
import 'package:emek_mobile/router.dart';
import 'package:emek_mobile/session/providers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class Call {
  Call(this.method, this.path, this.headers, this.body);
  final String method;
  final String path;
  final Map<String, String> headers;
  final Object? body;
  String? get idempotencyKey => headers['idempotency-key'];
}

/// Eşzamansız olabilir: testler bir isteği "yolda" tutabilir (ör. çıkış sırasında kayıt).
typedef Handler = FutureOr<http.Response> Function(Call call);

http.Response json(Object body, [int status = 200]) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

http.Response apiError(int status, String code, String message) => json({
  'error': {'code': code, 'message': message, 'requestId': 'req-$code'},
}, status);

/// Sahte core API: `'METHOD /yol'` → yanıt (yol `/api/v1` olmadan). Bilinmeyen uç 404.
class FakeBackend {
  FakeBackend(Map<String, Handler> routes) : routes = {..._defaults, ...routes};

  final Map<String, Handler> routes;
  final calls = <Call>[];

  static final Map<String, Handler> _defaults = {
    'POST /auth/session': (_) => json({
      'userId': 'u1',
      'roles': ['CUSTOMER'],
    }, 201),
    'GET /customers/me': (_) =>
        json({'userId': 'u1', 'displayName': 'Ayşe K.'}),
    'GET /service-categories': (_) => json([
      {'id': 'c1', 'slug': 'temizlik', 'name': 'Temizlik'},
    ]),
    'GET /services': (_) => json([
      {
        'id': 's1',
        'name': 'Detaylı Temizlik',
        'categorySlug': 'temizlik',
        'defaultDurationMinutes': 180,
      },
    ]),
    'GET /addresses': (_) => json([
      {
        'id': 'a1',
        'label': 'Ev',
        'city': 'İstanbul',
        'district': 'Kadıköy',
        'line': 'Moda Cd. 1',
        'latitude': 40.9909,
        'longitude': 29.0303,
      },
    ]),
  };

  List<Call> callsTo(String method, String path) =>
      calls.where((c) => c.method == method && c.path == path).toList();

  http.Client client() => MockClient((request) async {
    final path = request.url.path.replaceFirst(apiPrefix, '');
    final isJson =
        (request.headers['Content-Type'] ??
                request.headers['content-type'] ??
                '')
            .startsWith('application/json');
    // İmzalı URL'e PUT ham dosya baytlarıdır; yalnız JSON gövdeler çözülür.
    final body = request.body.isEmpty
        ? null
        : isJson
        ? jsonDecode(request.body)
        : request.bodyBytes;
    final call = Call(
      request.method,
      path,
      request.headers.map((k, v) => MapEntry(k.toLowerCase(), v)),
      body,
    );
    calls.add(call);
    final handler = routes['${request.method} $path'];
    return handler == null
        ? apiError(404, 'NOT_FOUND', 'Kaynak bulunamadı.')
        : handler(call);
  });
}

/// Yalnız sağlayıcı profili olan oturum (müşteri profili yok).
Map<String, Handler> providerSession({
  String state = 'APPROVED',
  String? bio = 'Deneyimliyim.',
}) => {
  'POST /auth/session': (_) => json({
    'userId': 'u1',
    'roles': ['PROVIDER'],
  }, 201),
  'GET /customers/me': (_) => apiError(404, 'PROFILE_NOT_FOUND', 'Profil yok.'),
  'GET /providers/me': (_) => json({
    'userId': 'u1',
    'displayName': 'Hatice Y.',
    'bio': bio,
    'experienceYears': 10,
    'maxDailyBookings': 2,
    'state': state,
  }),
};

/// Oturum açık bir müşteriyle uygulamayı başlatır ve [location]'a gider.
Future<ProviderContainer> pumpSignedInApp(
  WidgetTester tester,
  FakeBackend backend, {
  String location = '/',
  EvidencePicker? picker,
  LocationSource? locationSource,
  LocationAccess locationAccess = LocationAccess.granted,
  Coordinates? currentLocation,
  PushTokenSource? pushSource,
}) async {
  final auth = MockAuthAdapter()..signIn('dev-ayse', '+905321112233');
  final env = AppEnv(
    apiBaseUrl: Uri.parse('http://localhost:3000'),
    authMode: AuthMode.mock,
  );
  final api = ApiClient(
    baseUrl: env.apiBaseUrl,
    idToken: auth.idToken,
    httpClient: backend.client(),
  );
  await tester.pumpWidget(
    ProviderScope(
      retry: providerRetry,
      overrides: [
        envProvider.overrideWithValue(env),
        authAdapterProvider.overrideWithValue(auth),
        apiClientProvider.overrideWithValue(api),
        // İmzalı URL'e yükleme de sahte backend'e gider (kimlik başlığı taşımadığı doğrulanır).
        providerApiProvider.overrideWithValue(
          ProviderApi(api, uploadClient: backend.client()),
        ),
        if (picker != null) evidencePickerProvider.overrideWithValue(picker),
        // Gerçek konum donanımına asla dokunulmaz.
        locationSourceProvider.overrideWithValue(
          locationSource ?? NoLocationSource(),
        ),
        locationAccessProvider.overrideWithValue(() async => locationAccess),
        currentLocationProvider.overrideWithValue(() async => currentLocation),
        if (pushSource != null)
          pushTokenSourceProvider.overrideWithValue(pushSource),
      ],
      child: const EmekApp(),
    ),
  );
  // Kapsayıcı widget ağacına aittir: ağaç atılınca telemetri denetleyicisi de atılır ve
  // zamanlayıcısını durdurur (uygulamada denetleyici ekranlardan bağımsız yaşar).
  final container = ProviderScope.containerOf(
    tester.element(find.byType(EmekApp)),
  );
  await tester.pumpAndSettle();
  if (location != '/') {
    container.read(routerProvider).go(location);
    await tester.pumpAndSettle();
  }
  return container;
}

/// Hiç okuma üretmeyen kaynak (varsayılan) — başlatıldı mı, durdu mu izlenir.
class NoLocationSource implements LocationSource {
  int starts = 0;
  int stops = 0;
  @override
  Stream<LocationReading> start({required Duration interval}) {
    starts++;
    return const Stream.empty();
  }

  @override
  Future<void> stop() async => stops++;
}

/// Test tarafından beslenen kaynak.
class ScriptedLocationSource extends NoLocationSource {
  final _controller = StreamController<LocationReading>.broadcast();
  void emit(LocationReading reading) => _controller.add(reading);
  @override
  Stream<LocationReading> start({required Duration interval}) {
    starts++;
    return _controller.stream;
  }
}
