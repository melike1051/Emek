/// Backend hata sözleşmesi (docs/api/error-codes.md):
/// `{ "error": { "code", "message", "requestId", "details" } }`. `message` kullanıcıya
/// gösterilebilir güvenli metindir; istemci kendi metnini uydurmaz.
class ApiError implements Exception {
  const ApiError({
    required this.status,
    required this.code,
    required this.message,
    this.requestId,
    this.details,
  });

  /// Ağ kesintisi / sözleşme dışı yanıt için istemci tarafı kodlar (web ile aynı).
  static const networkCode = 'NETWORK_ERROR';
  static const unexpectedCode = 'UNEXPECTED_RESPONSE';

  factory ApiError.network() => const ApiError(
    status: 0,
    code: networkCode,
    message: 'Sunucuya ulaşılamadı. Bağlantınızı kontrol edip tekrar deneyin.',
  );

  factory ApiError.unexpected(int status) => ApiError(
    status: status,
    code: unexpectedCode,
    message: 'Beklenmeyen bir yanıt alındı. Lütfen tekrar deneyin.',
  );

  /// Gövde sözleşmeye uyuyorsa [ApiError], değilse `null`.
  static ApiError? fromBody(int status, Object? body) {
    if (body is! Map<String, dynamic>) return null;
    final error = body['error'];
    if (error is! Map<String, dynamic>) return null;
    final code = error['code'];
    final message = error['message'];
    if (code is! String || message is! String) return null;
    final details = error['details'];
    return ApiError(
      status: status,
      code: code,
      message: message,
      requestId: error['requestId'] as String?,
      details: details is Map<String, dynamic> ? details : null,
    );
  }

  final int status;
  final String code;
  final String message;
  final String? requestId;
  final Map<String, dynamic>? details;

  /// Oturum geçersiz → yeniden giriş gerekir.
  bool get isUnauthenticated => status == 401 && code == 'UNAUTHENTICATED';

  /// Tekrar denemek anlamlı mı? (ağ, oran sınırı, geçici bozulma) — web ile aynı.
  bool get isRetryable => status == 0 || status == 429 || status == 503;

  /// Sunucunun isteği işleyip işlemediği bilinmiyor (ağ, 5xx, `IDEMPOTENCY_IN_PROGRESS`).
  /// Yan etkili komutta bu durumda yalnız **aynı gövde + aynı anahtar** tekrar denenir.
  bool get isAmbiguous =>
      status == 0 || status >= 500 || code == 'IDEMPOTENCY_IN_PROGRESS';

  @override
  String toString() => 'ApiError($status $code)';
}
