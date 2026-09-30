import 'dart:async';
import 'dart:convert';

import 'package:emek_mobile/api/api_client.dart';
import 'package:emek_mobile/telemetry/telemetry_buffer.dart';
import 'package:emek_mobile/telemetry/telemetry_engine.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

final t0 = DateTime.utc(2026, 10, 12, 7);

LocationReading at(
  Duration offset, {
  bool mock = false,
  double speed = 1.2,
  double heading = 90,
}) => LocationReading(
  capturedAt: t0.add(offset),
  latitude: 40.99,
  longitude: 29.03,
  accuracyMeters: 8,
  speedMps: speed,
  headingDegrees: heading,
  isMock: mock,
);

class FakeSource implements LocationSource {
  final controller = StreamController<LocationReading>.broadcast();
  final intervals = <Duration>[];
  bool started = false;
  bool stopped = false;

  @override
  Stream<LocationReading> start({required Duration interval}) {
    started = true;
    stopped = false;
    intervals.add(interval);
    return controller.stream;
  }

  bool failNextStop = false;

  @override
  Future<void> stop() async {
    if (failNextStop) {
      failNextStop = false;
      throw StateError('platform');
    }
    stopped = true;
  }
}

void main() {
  group('TelemetryBuffer', () {
    test(
      'numaralandırma sunucunun lastSequence değerinden sürer; aralık uygulanır',
      () {
        final buffer = TelemetryBuffer(
          lastSequence: 41,
          interval: const Duration(seconds: 30),
        );
        expect(buffer.record(at(Duration.zero)), isTrue);
        expect(
          buffer.record(at(const Duration(seconds: 10))),
          isFalse,
        ); // aralık dolmadı
        expect(buffer.record(at(const Duration(seconds: 30))), isTrue);
        expect(buffer.pending.map((s) => s.sequence), [42, 43]);
      },
    );

    test('aralık 5 sn altına inmez (backend TOO_FREQUENT)', () {
      final buffer = TelemetryBuffer(
        lastSequence: 0,
        interval: const Duration(seconds: 1),
      );
      expect(buffer.interval, minSpacing);
      buffer.interval = const Duration(seconds: 2);
      expect(buffer.interval, minSpacing);
    });

    test('parti ≤ 20, en eskiler önce; bayat (>900 sn) örnekler atılır', () {
      final buffer = TelemetryBuffer(lastSequence: 0, interval: minSpacing);
      for (var i = 0; i < 30; i++) {
        buffer.record(at(Duration(seconds: i * 5)));
      }
      final batch = buffer.nextBatch(t0.add(const Duration(seconds: 150)));
      expect(batch, hasLength(maxSamplesPerBatch));
      expect(batch.first.sequence, 1);

      final later = buffer.nextBatch(t0.add(const Duration(seconds: 1000)));
      // 1000 - 900 = 100 sn öncesinden eskiler atıldı (0..95 sn → 20 örnek).
      expect(
        later.first.reading.capturedAt,
        t0.add(const Duration(seconds: 100)),
      );
    });

    test('onaylanan numaralar bırakılır; ağ hatasında hiçbiri', () {
      final buffer = TelemetryBuffer(lastSequence: 0, interval: minSpacing)
        ..record(at(Duration.zero))
        ..record(at(const Duration(seconds: 5)));
      buffer.acknowledge([1]);
      expect(buffer.pending.map((s) => s.sequence), [2]);
    });

    test(
      'JSON: bilinmeyen hız/yön (negatif) gönderilmez; sahte konum bildirilir',
      () {
        final json = TelemetrySample(
          7,
          at(Duration.zero, mock: true, speed: -1, heading: -1),
        ).toJson();
        expect(json.containsKey('speedMps'), isFalse);
        expect(json.containsKey('headingDegrees'), isFalse);
        expect(json['isMockLocation'], isTrue);
        expect(json['capturedAt'], '2026-10-12T07:00:00.000Z');
        expect(json['sequence'], 7);
      },
    );
  });

  group('TelemetryEngine', () {
    late List<Map<String, dynamic>> posted;
    late http.Response Function() respond;

    ApiClient client() => ApiClient(
      baseUrl: Uri.parse('http://localhost:3000'),
      idToken: () async => 'mock:p1',
      httpClient: MockClient((request) async {
        posted.add(jsonDecode(request.body) as Map<String, dynamic>);
        return respond();
      }),
    );

    http.Response ok(Map<String, dynamic> body) => http.Response(
      jsonEncode({
        'sessionId': 'ss1',
        'accepted': 1,
        'rejected': 0,
        'results': <Object>[],
        'telemetryIntervalSeconds': 30,
        ...body,
      }),
      200,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

    http.Response error(int status, String code) => http.Response(
      jsonEncode({
        'error': {'code': code, 'message': code},
      }),
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

    setUp(() => posted = []);

    test(
      'okuma → aralıkla gönderim; ağ hatasında aynı numaralar tekrar gider',
      () {
        fakeAsync((async) {
          var now = t0;
          final source = FakeSource();
          respond = () => error(503, 'SERVICE_UNAVAILABLE');
          final engine = TelemetryEngine(
            sessionId: 'ss1',
            client: client(),
            source: source,
            lastSequence: 3,
            interval: const Duration(seconds: 30),
            clock: () => now,
          );
          engine.start();
          async.flushMicrotasks();
          expect(source.started, isTrue);

          source.controller.add(at(Duration.zero));
          async.flushMicrotasks();
          now = t0.add(const Duration(seconds: 30));
          async.elapse(const Duration(seconds: 30));
          expect(posted, hasLength(1));
          expect((posted.single['samples'] as List).single['sequence'], 4);
          expect(engine.buffer.pendingCount, 1); // 503: tamponda kaldı

          respond = () => ok({});
          now = t0.add(const Duration(seconds: 60));
          async.elapse(const Duration(seconds: 30));
          expect(posted, hasLength(2));
          expect(
            (posted.last['samples'] as List).single['sequence'],
            4,
          ); // aynı numara
          expect(engine.buffer.pendingCount, 0);
          engine.stop();
          async.flushMicrotasks();
        });
      },
    );

    test(
      'oturum artık kabul etmiyorsa motor kendini durdurur (24 saat takip yok)',
      () {
        fakeAsync((async) {
          final source = FakeSource();
          respond = () => error(409, 'SAFETY_SESSION_ALREADY_CLOSED');
          final engine = TelemetryEngine(
            sessionId: 'ss1',
            client: client(),
            source: source,
            lastSequence: 0,
            interval: const Duration(seconds: 30),
            clock: () => t0,
          );
          engine.start();
          async.flushMicrotasks();
          source.controller.add(at(Duration.zero));
          async.flushMicrotasks();
          engine.flush();
          async.flushMicrotasks();
          expect(engine.phase, TelemetryPhase.stopped);
          expect(source.stopped, isTrue);
        });
      },
    );

    test('kalıcı sözleşme hatası (422) partiyi bırakır; 401 bırakmaz', () {
      fakeAsync((async) {
        final source = FakeSource();
        final engine = TelemetryEngine(
          sessionId: 'ss1',
          client: client(),
          source: source,
          lastSequence: 0,
          interval: const Duration(seconds: 30),
          clock: () => t0,
        );
        engine.start();
        async.flushMicrotasks();
        source.controller.add(at(Duration.zero));
        async.flushMicrotasks();

        respond = () => error(401, 'UNAUTHENTICATED');
        engine.flush();
        async.elapse(const Duration(milliseconds: 10));
        expect(engine.buffer.pendingCount, 1);

        respond = () => error(422, 'VALIDATION_FAILED');
        engine.flush();
        async.elapse(const Duration(milliseconds: 10));
        expect(engine.buffer.pendingCount, 0);
        engine.stop();
        async.flushMicrotasks();
      });
    });

    test(
      'sunucunun yeni aralığı uygulanır; kaynak yeni aralıkla yeniden kurulur (R-113)',
      () async {
        final source = FakeSource();
        respond = () => ok({'telemetryIntervalSeconds': 60});
        final engine = TelemetryEngine(
          sessionId: 'ss1',
          client: client(),
          source: source,
          lastSequence: 0,
          interval: const Duration(seconds: 30),
          clock: () => t0,
        );
        await engine.start();
        source.controller.add(at(Duration.zero));
        await Future<void>.delayed(Duration.zero);
        await engine.flush();
        expect(engine.buffer.interval, const Duration(seconds: 60));
        expect(source.intervals, [
          const Duration(seconds: 30),
          const Duration(seconds: 60),
        ]);
        expect(source.stopped, isFalse);
        await engine.stop();
        expect(source.stopped, isTrue);
      },
    );

    test(
      'aralık değişiminde kaynak durdurma hatası motoru sessiz bırakmaz',
      () async {
        final source = FakeSource()..failNextStop = true;
        respond = () => ok({'telemetryIntervalSeconds': 60});
        final engine = TelemetryEngine(
          sessionId: 'ss1',
          client: client(),
          source: source,
          lastSequence: 0,
          interval: const Duration(seconds: 30),
          clock: () => t0,
        );
        await engine.start();
        source.controller.add(at(Duration.zero));
        await Future<void>.delayed(Duration.zero);
        await engine.flush();
        expect(engine.phase, TelemetryPhase.running);
        expect(source.intervals.last, const Duration(seconds: 60));
        await engine.stop();
      },
    );
  });
}
