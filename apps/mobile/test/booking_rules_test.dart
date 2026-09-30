import 'package:emek_mobile/domain/booking_rules.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('CustomerActions (web customerActions ile aynı)', () {
    test('ödeme yalnız CONFIRMED; hizmet onayı yalnız CHECKED_OUT', () {
      expect(CustomerActions.of('CONFIRMED').canPay, isTrue);
      expect(CustomerActions.of('PROVIDER_PENDING').canPay, isFalse);
      expect(CustomerActions.of('CHECKED_OUT').canConfirmService, isTrue);
      expect(CustomerActions.of('IN_PROGRESS').canConfirmService, isFalse);
    });

    test(
      'iptal hizmet başlamadan; itiraz tamamlanma çevresinde; değerlendirme sonda',
      () {
        expect(CustomerActions.of('PROVIDER_ARRIVING').canCancel, isTrue);
        expect(CustomerActions.of('CHECKED_IN').canCancel, isFalse);
        expect(CustomerActions.of('COMPLETED').canDispute, isTrue);
        expect(CustomerActions.of('SETTLED').canDispute, isFalse);
        expect(CustomerActions.of('SETTLED').canReview, isTrue);
        expect(CustomerActions.of('CHECKED_OUT').canReview, isFalse);
      },
    );

    test('güvenlik ekranı hizmet günü akışında ve SAFETY_HOLD’da', () {
      for (final status in ['SCHEDULED', 'IN_PROGRESS', 'SAFETY_HOLD']) {
        expect(
          CustomerActions.of(status).hasSafetySession,
          isTrue,
          reason: status,
        );
      }
      expect(CustomerActions.of('CONFIRMED').hasSafetySession, isFalse);
    });

    test('bilinmeyen durum hiçbir eyleme izin vermez (deny by default)', () {
      final actions = CustomerActions.of('SOMETHING_NEW');
      expect([
        actions.canPay,
        actions.canCancel,
        actions.canConfirmService,
        actions.canReview,
        actions.canDispute,
      ], everyElement(isFalse));
      expect(bookingStatusView('SOMETHING_NEW').label, 'SOMETHING_NEW');
    });
  });

  test('formatMoney: string minor unit, BigInt, binlik ayırıcı, negatif', () {
    expect(formatMoney('96000', 'TRY'), '960,00 ₺');
    expect(formatMoney('5', 'TRY'), '0,05 ₺');
    expect(formatMoney('123456789', 'TRY'), '1.234.567,89 ₺');
    expect(formatMoney('-1500', 'EUR'), '-15,00 EUR');
    // int'e sığmayan BIGINT de hassasiyet kaybetmeden yazılır.
    expect(
      formatMoney('92233720368547758070', 'TRY'),
      '922.337.203.685.477.580,70 ₺',
    );
    expect(formatMoney('abc', 'TRY'), 'abc TRY');
  });

  test(
    'tarih/saat her zaman İstanbul saatiyle (cihaz diliminden bağımsız)',
    () {
      final start = DateTime.utc(2026, 10, 12, 7);
      final end = DateTime.utc(2026, 10, 12, 10);
      expect(formatRange(start, end), '12 Eki 2026 10:00 – 13:00');
      // UTC 22:30 İstanbul'da ertesi gündür.
      expect(formatDate(DateTime.utc(2026, 12, 31, 22, 30)), '1 Oca 2027');
      expect(formatCalendarDay(DateTime(2026, 9, 30)), '30 Eyl 2026');
    },
  );

  group('buildWindow (web buildWindow ile aynı kurallar)', () {
    final now = DateTime.utc(2026, 9, 29, 12);
    WindowResult build({
      DateTime? date,
      ({int hour, int minute})? from = (hour: 11, minute: 0),
      ({int hour, int minute})? to = (hour: 21, minute: 0),
      int duration = 180,
    }) => buildWindow(
      date: date ?? DateTime(2026, 9, 30),
      from: from,
      to: to,
      durationMinutes: duration,
      now: now,
    );

    test('İstanbul 11:00–21:00 → UTC 08:00–18:00', () {
      final result = build() as WindowOk;
      expect(result.start, DateTime.utc(2026, 9, 30, 8));
      expect(result.end, DateTime.utc(2026, 9, 30, 18));
    });

    test('hatalar', () {
      String message(WindowResult r) => (r as WindowError).message;
      expect(message(build(from: null)), 'Tarih ve saat aralığını seçin.');
      expect(message(build(duration: 20)), contains('30 dakika'));
      expect(
        message(build(from: (hour: 21, minute: 0), to: (hour: 11, minute: 0))),
        contains('Bitiş'),
      );
      expect(message(build(date: DateTime(2026, 9, 29))), contains('Geçmiş'));
      expect(message(build(to: (hour: 12, minute: 0))), contains('kısa'));
    });
  });

  test('explanationText: kapalı küme; bilinmeyen kod gösterilmez', () {
    expect(explanationText('NEARBY', 3.4), 'Yaklaşık 3 km uzaklıkta');
    expect(explanationText('NEARBY', null), 'Size yakın');
    expect(explanationText('HIGH_RATING', 4.75), 'Yüksek puanlı (4,8/5)');
    expect(explanationText('BRAND_NEW_CODE', 1), isNull);
  });

  test('needsReview: yalnız 0,8 altı tavsiye; form yolunda (null) yok', () {
    expect(needsReview(0.7), isTrue);
    expect(needsReview(0.85), isFalse);
    expect(needsReview(null), isFalse);
  });

  test('trUpper Türkçe büyük harf kurallarını uygular', () {
    expect(trUpper('Güvenlik & oturum'), 'GÜVENLİK & OTURUM');
    expect(trUpper('Acil durum ısı'), 'ACİL DURUM ISI');
  });
}
