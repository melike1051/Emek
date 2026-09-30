import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:geolocator/geolocator.dart';

import 'telemetry_buffer.dart';
import 'telemetry_engine.dart';

/// Konum izni sonucu (kullanıcıya ne yapacağını söylemek için).
enum LocationAccess { granted, denied, deniedForever, serviceDisabled }

/// "Uygulama kullanılırken" izni ister; **"her zaman" izni istenmez** (ADR-0025 §8): arka planda
/// sürmesi Android'de ön plan servisiyle, iOS'ta oturum süresince arka plan konum moduyla sağlanır.
Future<LocationAccess> ensureLocationAccess() async {
  if (!await Geolocator.isLocationServiceEnabled()) {
    return LocationAccess.serviceDisabled;
  }
  var permission = await Geolocator.checkPermission();
  if (permission == LocationPermission.denied) {
    permission = await Geolocator.requestPermission();
  }
  return switch (permission) {
    LocationPermission.whileInUse ||
    LocationPermission.always => LocationAccess.granted,
    LocationPermission.deniedForever => LocationAccess.deniedForever,
    _ => LocationAccess.denied,
  };
}

/// Tek seferlik konum (adres / bölge merkezi doldurmak için). Hizmet oturumu dışında konum
/// **yalnız kullanıcı düğmeye bastığında** okunur ve sunucuya yalnız kaydettiği adres gider.
Future<Position?> currentPositionOnce() async {
  if (await ensureLocationAccess() != LocationAccess.granted) return null;
  return Geolocator.getCurrentPosition(
    locationSettings: const LocationSettings(
      accuracy: LocationAccuracy.high,
      timeLimit: Duration(seconds: 20),
    ),
  );
}

/// Hizmet oturumu konum kaynağı.
class GeolocatorSource implements LocationSource {
  StreamSubscription<Position>? _subscription;
  StreamController<LocationReading>? _controller;

  @override
  Stream<LocationReading> start({required Duration interval}) {
    final controller = StreamController<LocationReading>();
    _controller = controller;
    _subscription =
        Geolocator.getPositionStream(
          locationSettings: _settings(interval),
        ).listen(
          (p) => controller.add(
            LocationReading(
              capturedAt: p.timestamp.toUtc(),
              latitude: p.latitude,
              longitude: p.longitude,
              accuracyMeters: p.accuracy,
              speedMps: p.speed >= 0 ? p.speed : null,
              headingDegrees: p.heading >= 0 ? p.heading : null,
              // Android `isMock`, iOS `isSimulatedBySoftware` — dürüstçe bildirilir, yargı sunucuda.
              isMock: p.isMocked,
            ),
          ),
          onError: controller.addError,
        );
    return controller.stream;
  }

  @override
  Future<void> stop() async {
    await _subscription?.cancel();
    _subscription = null;
    await _controller?.close();
    _controller = null;
  }

  LocationSettings _settings(
    Duration interval,
  ) => switch (defaultTargetPlatform) {
    TargetPlatform.android => AndroidSettings(
      accuracy: LocationAccuracy.high,
      intervalDuration: interval,
      // Ön plan servisi: uygulama arka plandayken de sürer, kalıcı bildirim görünür; oturum
      // kapanınca servis durur. `ACCESS_BACKGROUND_LOCATION` istenmez.
      foregroundNotificationConfig: const ForegroundNotificationConfig(
        notificationTitle: 'Emek güvenlik oturumu',
        notificationText:
            'Konumunuz yalnız bu hizmet süresince paylaşılıyor. Hizmet bitince durur.',
        enableWakeLock: false,
        setOngoing: true,
      ),
    ),
    TargetPlatform.iOS => AppleSettings(
      accuracy: LocationAccuracy.best,
      activityType: ActivityType.otherNavigation,
      pauseLocationUpdatesAutomatically: false,
      allowBackgroundLocationUpdates: true,
      // Arka planda konum kullanıldığını sistem göstergesi (mavi çubuk) açıkça gösterir.
      showBackgroundLocationIndicator: true,
    ),
    _ => const LocationSettings(accuracy: LocationAccuracy.high),
  };
}
