/// Türkiye cep telefonunu E.164'e çevirir (web `normalizeTrPhone` ile aynı kurallar):
/// `0532 111 22 33`, `532...`, `+90 532...` → `+905321112233`. Geçersizse `null`.
String? normalizeTrPhone(String input) {
  final digits = input.replaceAll(RegExp(r'[\s()-]'), '');
  final match = RegExp(r'^(?:\+90|90|0)?(5\d{9})$').firstMatch(digits);
  return match == null ? null : '+90${match.group(1)}';
}

/// Firebase telefon doğrulama hatalarının kullanıcı metni; ham hata gösterilmez.
String firebaseAuthMessage(String? code) => switch (code) {
  'invalid-phone-number' => 'Telefon numarası geçersiz.',
  'too-many-requests' =>
    'Çok fazla deneme yapıldı. Lütfen biraz sonra tekrar deneyin.',
  'invalid-verification-code' => 'Kod hatalı. Lütfen tekrar deneyin.',
  'session-expired' => 'Kodun süresi doldu. Yeni kod isteyin.',
  'network-request-failed' =>
    'Bağlantı kurulamadı. İnternetinizi kontrol edin.',
  _ => 'Giriş yapılamadı. Lütfen tekrar deneyin.',
};
