import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';

import '../domain/booking_rules.dart';
import '../widgets/common.dart';
import '../widgets/error_view.dart';
import 'geolocator_source.dart';
import 'telemetry_controller.dart';
import 'telemetry_engine.dart';

/// Sağlayıcıya konum paylaşımının durumu. Bilinçli olarak dar: koordinat, geofence ya da risk
/// gösterilmez (ADR-0019 §9) — yalnız paylaşım açık mı, en son ne zaman gitti, bekleyen var mı.
class TelemetryCard extends ConsumerWidget {
  const TelemetryCard({super.key, required this.sessionId});
  final String sessionId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(telemetryControllerProvider);
    if (state.sessionId != sessionId) {
      return SectionCard(
        title: 'Konum paylaşımı',
        children: [
          // Başlatma hatası oturum kimliği atanmadan da oluşabilir; gizlenmez.
          if (state.error != null)
            ErrorView(error: state.error!)
          else
            const Text('Konum paylaşımı başlatılıyor…'),
        ],
      );
    }
    final status = state.status;
    return SectionCard(
      title: 'Konum paylaşımı',
      trailing: StatusBadge(
        state.running
            ? const StatusView('Açık', Tone.trust)
            : const StatusView('Kapalı', Tone.danger),
      ),
      children: [
        if (state.error != null) ErrorView(error: state.error!),
        ...switch (state.access) {
          LocationAccess.denied => [
            const Notice(
              'Konum izni verilmedi. Güvenlik oturumu süresince konumunuz gerekir; izin '
              'verdiğinizde paylaşım otomatik başlar.',
              danger: true,
            ),
          ],
          LocationAccess.deniedForever => [
            const Notice(
              'Konum izni kapalı. Ayarlardan “Uygulamayı kullanırken” iznini açın.',
              danger: true,
            ),
            OutlinedButton(
              onPressed: Geolocator.openAppSettings,
              child: const Text('Ayarları aç'),
            ),
          ],
          LocationAccess.serviceDisabled => [
            const Notice('Cihazınızın konum servisi kapalı.', danger: true),
            OutlinedButton(
              onPressed: Geolocator.openLocationSettings,
              child: const Text('Konum ayarlarını aç'),
            ),
          ],
          _ => const <Widget>[],
        },
        if (state.running) ...[
          const Text(
            'Konumunuz yalnız bu hizmet süresince paylaşılıyor; hizmet bitince otomatik durur. '
            'Müşteri konumunuzu görmez.',
          ),
          const SizedBox(height: 8),
          Text(
            status?.lastSentAt == null
                ? 'Henüz gönderilmedi.'
                : 'Son gönderim: ${formatTime(status!.lastSentAt!)}',
          ),
          if ((status?.pending ?? 0) > 0)
            Text(
              'Bağlantı bekleyen ${status!.pending} konum kaydı var; bağlantı gelince gönderilir.',
            ),
        ],
        if (status?.phase == TelemetryPhase.stopped)
          const Text('Oturum konum kabul etmiyor; paylaşım durdu.'),
      ],
    );
  }
}
