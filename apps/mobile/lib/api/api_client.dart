import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'api_error.dart';

const apiPrefix = '/api/v1';

/// Token sağlayıcıları: Firebase ID token (ADR-0016) ve App Check token'ı (ADR-0022).
typedef TokenProvider = Future<String?> Function();

/// İnce tipli API istemcisi (`packages/api-client` ile aynı sözleşme). Modeller elle yazılır
/// ve kaynak DTO'ya işaret eder (ADR-0025, R-99).
class ApiClient {
  ApiClient({
    required this.baseUrl,
    required this.idToken,
    TokenProvider? appCheckToken,
    http.Client? httpClient,
    this.timeout = const Duration(seconds: 20),
  }) : _appCheckToken = appCheckToken,
       _http = httpClient ?? http.Client();

  final Uri baseUrl;
  final TokenProvider idToken;
  final TokenProvider? _appCheckToken;
  final http.Client _http;
  final Duration timeout;

  Uri buildUri(String path, [Map<String, Object?>? query]) {
    if (!path.startsWith('/')) {
      throw ArgumentError.value(path, 'path', "'/' ile başlamalı");
    }
    final params = <String, String>{
      for (final entry in (query ?? const <String, Object?>{}).entries)
        if (entry.value != null && entry.value != '')
          entry.key: '${entry.value}',
    };
    final root = baseUrl.toString().replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$root$apiPrefix$path');
    return params.isEmpty ? uri : uri.replace(queryParameters: params);
  }

  /// [idempotencyKey]: yan etkili komutun anahtarı. Aynı kullanıcı eyleminin aynı gövdeyle
  /// tekrarında **aynı** anahtar verilmelidir (bkz. `IdempotencyKey`).
  Future<Object?> request(
    String method,
    String path, {
    Object? body,
    Map<String, Object?>? query,
    String? idempotencyKey,
  }) async {
    final tokens = await Future.wait([
      idToken(),
      _appCheckToken?.call() ?? Future<String?>.value(),
    ]);
    final headers = <String, String>{'Accept': 'application/json'};
    if (tokens[0] != null) headers['Authorization'] = 'Bearer ${tokens[0]}';
    if (tokens[1] != null) headers['X-Firebase-AppCheck'] = tokens[1]!;
    if (idempotencyKey != null) headers['Idempotency-Key'] = idempotencyKey;

    final request = http.Request(method, buildUri(path, query))
      ..headers.addAll(headers);
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.body = jsonEncode(body);
    }

    final http.Response response;
    try {
      response = await http.Response.fromStream(
        await _http.send(request).timeout(timeout),
      );
    } on TimeoutException {
      throw ApiError.network();
    } on http.ClientException {
      throw ApiError.network();
    }

    if (response.statusCode == 204) return null;
    Object? parsed;
    if (response.bodyBytes.isNotEmpty) {
      try {
        parsed = jsonDecode(utf8.decode(response.bodyBytes));
      } on FormatException {
        throw ApiError.unexpected(response.statusCode);
      }
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw ApiError.fromBody(response.statusCode, parsed) ??
          ApiError.unexpected(response.statusCode);
    }
    return parsed;
  }

  Future<Object?> get(String path, {Map<String, Object?>? query}) =>
      request('GET', path, query: query);

  Future<Object?> post(String path, {Object? body, String? idempotencyKey}) =>
      request('POST', path, body: body, idempotencyKey: idempotencyKey);

  Future<Object?> patch(String path, {Object? body}) =>
      request('PATCH', path, body: body);

  Future<Object?> delete(String path, {String? idempotencyKey}) =>
      request('DELETE', path, idempotencyKey: idempotencyKey);

  /// `/bookings/{id}` gibi şablonlarda güvenli yol parçası.
  static String segment(String value) => Uri.encodeComponent(value);
}
