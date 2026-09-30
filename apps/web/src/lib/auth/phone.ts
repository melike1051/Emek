/**
 * Türkiye cep numarasını E.164'e çevirir (backend UpdateUserDto ile aynı kural).
 * Kabul: "0532 111 22 33", "532 111 2233", "+90 532 111 22 33", "905321112233".
 * Geçersizse `null`.
 */
export function normalizeTrPhone(input: string): string | null {
  const digits = input.replace(/[\s()-]/g, '');
  let national: string;
  if (/^\+90\d{10}$/.test(digits)) national = digits.slice(3);
  else if (/^90\d{10}$/.test(digits)) national = digits.slice(2);
  else if (/^0\d{10}$/.test(digits)) national = digits.slice(1);
  else if (/^\d{10}$/.test(digits)) national = digits;
  else return null;
  // Türkiye cep hatları 5 ile başlar.
  return national.startsWith('5') ? `+90${national}` : null;
}

/** Firebase Auth hata kodlarını güvenli Türkçe mesaja çevirir; bilinmeyen kod genel mesaj alır. */
export function firebaseAuthMessage(code: string | undefined): string {
  switch (code) {
    case 'auth/invalid-phone-number':
      return 'Telefon numarası geçersiz.';
    case 'auth/too-many-requests':
    case 'auth/quota-exceeded':
      return 'Çok fazla deneme yapıldı. Lütfen biraz sonra tekrar deneyin.';
    case 'auth/invalid-verification-code':
      return 'Doğrulama kodu hatalı.';
    case 'auth/code-expired':
      return 'Kodun süresi doldu. Yeni kod isteyin.';
    case 'auth/network-request-failed':
      return 'Bağlantı kurulamadı. İnternetinizi kontrol edin.';
    default:
      return 'Giriş yapılamadı. Lütfen tekrar deneyin.';
  }
}
