import 'dart:convert';
import 'dart:typed_data';

import 'package:emek_mobile/api/provider_api.dart';
import 'package:emek_mobile/domain/provider_rules.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('ProviderActions (web providerActions ile aynı)', () {
    test('yanıt yalnız PROVIDER_PENDING; ret ayrı uç değil', () {
      expect(ProviderActions.of('PROVIDER_PENDING').canRespond, isTrue);
      expect(ProviderActions.of('PROVIDER_PENDING').canCancel, isFalse);
      expect(ProviderActions.of('CONFIRMED').canRespond, isFalse);
    });

    test('hizmet günü adımları sırayla', () {
      expect(ProviderActions.of('SCHEDULED').next!.to, 'PROVIDER_ARRIVING');
      expect(ProviderActions.of('PROVIDER_ARRIVING').next!.to, 'CHECKED_IN');
      expect(ProviderActions.of('CHECKED_IN').next!.to, 'IN_PROGRESS');
      expect(ProviderActions.of('IN_PROGRESS').next!.to, 'CHECKED_OUT');
      expect(ProviderActions.of('CHECKED_OUT').next, isNull);
    });

    test('kanıt türleri akışa bağlı', () {
      expect(ProviderActions.of('SCHEDULED').uploadable, isEmpty);
      expect(ProviderActions.of('CHECKED_IN').uploadable, ['BEFORE_PHOTO']);
      expect(ProviderActions.of('IN_PROGRESS').uploadable, [
        'BEFORE_PHOTO',
        'AFTER_PHOTO',
      ]);
      expect(ProviderActions.of('CHECKED_OUT').uploadable, ['AFTER_PHOTO']);
    });

    test('hizmet adresi planlanmıştan check-out’a kadar (R-102)', () {
      for (final status in [
        'SCHEDULED',
        'PROVIDER_ARRIVING',
        'CHECKED_IN',
        'IN_PROGRESS',
        'CHECKED_OUT',
      ]) {
        expect(ProviderActions.of(status).address, AddressVisibility.visible);
      }
      for (final status in [
        'PROVIDER_PENDING',
        'CONFIRMED',
        'PAYMENT_AUTHORIZED',
      ]) {
        expect(
          ProviderActions.of(status).address,
          AddressVisibility.afterPayment,
        );
      }
      for (final status in [
        'COMPLETED',
        'SETTLED',
        'CANCELLED',
        'SAFETY_HOLD',
      ]) {
        expect(ProviderActions.of(status).address, AddressVisibility.closed);
      }
    });

    test('iptal hizmet başlamadan; sonrasında yalnız destek', () {
      expect(ProviderActions.of('PROVIDER_ARRIVING').canCancel, isTrue);
      expect(ProviderActions.of('CHECKED_IN').canCancel, isFalse);
    });

    test('etiket sağlayıcının bakışıdır', () {
      expect(
        providerBookingStatusView('PROVIDER_PENDING').label,
        'Yanıtınız bekleniyor',
      );
      expect(
        providerBookingStatusView('CHECKED_OUT').label,
        'Müşteri onayı bekleniyor',
      );
    });
  });

  test('readiness: kimlik başvuruyu bloklamaz', () {
    final items = readiness(
      bio: 'On yıllık deneyim',
      hasActiveService: true,
      hasActiveArea: true,
      upcomingAvailability: 1,
      identityVerified: false,
    );
    expect(canSubmitApplication(items), isTrue);
    expect(items.firstWhere((i) => i.key == 'identity').done, isFalse);
    expect(
      canSubmitApplication(
        readiness(
          bio: '  ',
          hasActiveService: true,
          hasActiveArea: true,
          upcomingAvailability: 1,
          identityVerified: true,
        ),
      ),
      isFalse,
    );
  });

  test('İstanbul günü ve hafta: cihaz diliminden bağımsız', () {
    // UTC 22:30 İstanbul'da ertesi gündür.
    expect(
      istanbulDay(DateTime.utc(2026, 9, 29, 22, 30)),
      DateTime.utc(2026, 9, 30),
    );
    expect(
      istanbulAt(DateTime.utc(2026, 9, 30), 9, 0),
      DateTime.utc(2026, 9, 30, 6),
    );
    // 30 Eylül 2026 çarşamba → pazartesi 28 Eylül.
    expect(weekStart(DateTime.utc(2026, 9, 30)), DateTime.utc(2026, 9, 28));
    expect(weekStart(DateTime.utc(2026, 10, 4)), DateTime.utc(2026, 9, 28));
    expect(dayTitle(DateTime.utc(2026, 9, 30)), 'Çarşamba, 30 Eyl 2026');
  });

  test('formatRadius', () {
    expect(formatRadius(500), '500 m');
    expect(formatRadius(5000), '5 km');
    expect(formatRadius(1500), '1,5 km');
  });

  test('sha256Hex bilinen özeti üretir', () {
    expect(
      sha256Hex(Uint8List.fromList(utf8.encode('abc'))),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
}
