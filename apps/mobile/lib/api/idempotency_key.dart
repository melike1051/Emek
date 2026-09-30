import 'package:uuid/uuid.dart';

/// Bir kullanıcı eyleminin `Idempotency-Key`'i (ADR-0024 Sonuçlar, ADR-0025).
///
/// Aynı eylemin **aynı gövdeyle** tekrarı (ağ hatası sonrası "Tekrar dene") aynı anahtarı
/// taşır ki backend komutu ikinci kez işlemesin. Gövde değişince ([signature]) yeni anahtar
/// üretilir: backend gövde parmak izi uymayan anahtarı `IDEMPOTENCY_KEY_REUSED` ile kalıcı
/// reddeder. Başarıdan sonra [rotate]. Anahtar yalnız bellekte tutulur.
class IdempotencyKey {
  IdempotencyKey({String Function()? generate})
    : _generate = generate ?? (() => const Uuid().v4());

  final String Function() _generate;
  String? _key;
  String? _signature;

  String current([String signature = '']) {
    if (_key == null || _signature != signature) {
      _key = _generate();
      _signature = signature;
    }
    return _key!;
  }

  void rotate() {
    _key = null;
    _signature = null;
  }
}
