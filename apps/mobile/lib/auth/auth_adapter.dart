import 'dart:async';

/// Kimlik sağlayıcısından bağımsız giriş yüzeyi (web `AuthAdapter` ile aynı rol).
abstract interface class AuthAdapter {
  /// Oturum açık mı? Abonelikte mevcut durumu hemen yayınlar.
  Stream<bool> get signedInChanges;

  bool get isSignedIn;

  /// Backend'e gidecek ID token (ADR-0016). Oturum yoksa `null`.
  Future<String?> idToken();

  /// App Check token'ı (ADR-0022). Kapalı ortamda `null`.
  Future<String?> appCheckToken();

  Future<void> signOut();
}

/// Yalnız yerel geliştirme (`AUTH_MODE=mock`, backend `AUTH_PROVIDER=mock`).
/// Token biçimi backend `MockTokenVerifier` ile aynı: `mock:<subject>[:phone=<+90...>]`.
/// Token **yalnız bellekte** tutulur; uygulama kapanınca oturum biter.
class MockAuthAdapter implements AuthAdapter {
  final _changes = StreamController<bool>.broadcast();
  String? _token;

  static final _subjectPattern = RegExp(r'^[A-Za-z0-9_-]{1,64}$');

  static String buildToken(String subject, String? phoneE164) {
    final clean = subject.trim();
    if (!_subjectPattern.hasMatch(clean)) {
      throw const FormatException(
        'Geçersiz geliştirici kimliği: harf, rakam, "-" ve "_" kullanın.',
      );
    }
    return phoneE164 == null ? 'mock:$clean' : 'mock:$clean:phone=$phoneE164';
  }

  void signIn(String subject, String? phoneE164) {
    _token = buildToken(subject, phoneE164);
    _changes.add(true);
  }

  @override
  Stream<bool> get signedInChanges async* {
    yield isSignedIn;
    yield* _changes.stream;
  }

  @override
  bool get isSignedIn => _token != null;

  @override
  Future<String?> idToken() async => _token;

  @override
  Future<String?> appCheckToken() async => null;

  @override
  Future<void> signOut() async {
    _token = null;
    _changes.add(false);
  }
}
