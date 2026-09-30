import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/booking_rules.dart';
import '../telemetry/telemetry_controller.dart';
import '../theme/theme.dart';
import 'error_view.dart';

/// Durum rozeti. Durum yalnız renkle anlatılmaz (WCAG 1.4.1): etiket her zaman yazılıdır.
class StatusBadge extends StatelessWidget {
  const StatusBadge(this.view, {super.key});
  final StatusView view;

  @override
  Widget build(BuildContext context) {
    final (background, foreground) = switch (view.tone) {
      Tone.trust => (EmekColors.secondaryTint, EmekColors.secondary),
      Tone.highlight => (const Color(0xFFF7EDE8), EmekColors.primaryStrong),
      Tone.danger => (EmekColors.dangerTint, EmekColors.danger),
      Tone.neutral => (EmekColors.surfaceMuted, EmekColors.textMuted),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        view.label,
        style: TextStyle(
          color: foreground,
          fontWeight: FontWeight.w600,
          fontSize: 13,
        ),
      ),
    );
  }
}

/// Başlıklı kart bölümü.
class SectionCard extends StatelessWidget {
  const SectionCard({
    super.key,
    required this.title,
    required this.children,
    this.trailing,
  });
  final String title;
  final Widget? trailing;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 16),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    trUpper(title),
                    style: Theme.of(context).textTheme.labelMedium?.copyWith(
                      color: EmekColors.primaryStrong,
                      letterSpacing: 1.1,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                ?trailing,
              ],
            ),
            const SizedBox(height: 12),
            ...children,
          ],
        ),
      ),
    );
  }
}

/// Bilgi / uyarı notu (`role=status` karşılığı: canlı bölge).
class Notice extends StatelessWidget {
  const Notice(this.text, {super.key, this.danger = false});
  final String text;
  final bool danger;

  @override
  Widget build(BuildContext context) => Semantics(
    liveRegion: true,
    child: Container(
      padding: const EdgeInsets.all(12),
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(
        color: danger ? EmekColors.dangerTint : EmekColors.surfaceMuted,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(text),
    ),
  );
}

/// `AsyncValue` gövdesi: yükleniyor / hata (güvenli mesaj + tekrar dene) / veri.
class AsyncBody<T> extends StatelessWidget {
  const AsyncBody({
    super.key,
    required this.value,
    required this.onRetry,
    required this.data,
  });
  final AsyncValue<T> value;
  final VoidCallback onRetry;
  final Widget Function(T data) data;

  @override
  Widget build(BuildContext context) => switch (value) {
    AsyncData(:final value) => data(value),
    AsyncError(:final error) => Padding(
      padding: const EdgeInsets.all(16),
      child: ErrorView(error: error, onRetry: onRetry),
    ),
    _ => const Padding(
      padding: EdgeInsets.all(32),
      child: Center(child: CircularProgressIndicator()),
    ),
  };
}

/// İki adımlı onay: yıkıcı/geri alınamaz komutlar tek dokunuşla gönderilmez (web `ConfirmStep`).
class ConfirmStep extends StatefulWidget {
  const ConfirmStep({
    super.key,
    required this.label,
    required this.confirmLabel,
    required this.busy,
    required this.onConfirm,
    this.danger = false,
    this.child,
  });
  final String label;
  final String confirmLabel;
  final bool busy;
  final bool danger;
  final VoidCallback onConfirm;
  final Widget? child;

  @override
  State<ConfirmStep> createState() => _ConfirmStepState();
}

class _ConfirmStepState extends State<ConfirmStep> {
  bool _asking = false;

  @override
  Widget build(BuildContext context) {
    if (!_asking) {
      return widget.danger
          ? OutlinedButton(
              onPressed: () => setState(() => _asking = true),
              child: Text(widget.label),
            )
          : FilledButton(
              onPressed: () => setState(() => _asking = true),
              child: Text(widget.label),
            );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ?widget.child,
        const SizedBox(height: 8),
        FilledButton(
          style: widget.danger
              ? FilledButton.styleFrom(backgroundColor: EmekColors.danger)
              : null,
          onPressed: widget.busy ? null : widget.onConfirm,
          child: widget.busy ? const _Spinner() : Text(widget.confirmLabel),
        ),
        TextButton(
          onPressed: widget.busy ? null : () => setState(() => _asking = false),
          child: const Text('Vazgeç'),
        ),
      ],
    );
  }
}

class _Spinner extends StatelessWidget {
  const _Spinner();
  @override
  Widget build(BuildContext context) => const SizedBox.square(
    dimension: 20,
    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
  );
}

/// Yükleniyor durumlu birincil düğme.
class BusyButton extends StatelessWidget {
  const BusyButton({
    super.key,
    required this.label,
    required this.busy,
    required this.onPressed,
  });
  final String label;
  final bool busy;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) => FilledButton(
    onPressed: busy ? null : onPressed,
    child: busy ? const _Spinner() : Text(label),
  );
}

/// "Konumumu kullan": konumu **yalnız dokununca** bir kez okur ve alanları doldurur; kullanıcı
/// kaydetmeden hiçbir şey sunucuya gitmez.
class UseMyLocationButton extends ConsumerStatefulWidget {
  const UseMyLocationButton({super.key, required this.onLocated});
  final void Function(double latitude, double longitude) onLocated;

  @override
  ConsumerState<UseMyLocationButton> createState() =>
      _UseMyLocationButtonState();
}

class _UseMyLocationButtonState extends ConsumerState<UseMyLocationButton> {
  bool _busy = false;
  String? _message;

  Future<void> _locate() async {
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final coordinates = await ref.read(currentLocationProvider)();
      if (!mounted) return;
      if (coordinates == null) {
        setState(
          () => _message =
              'Konum alınamadı: izin verilmedi ya da konum servisi kapalı.',
        );
      } else {
        widget.onLocated(coordinates.latitude, coordinates.longitude);
      }
    } on Exception {
      if (mounted) {
        setState(
          () => _message = 'Konum alınamadı. Koordinatı elle girebilirsiniz.',
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      OutlinedButton.icon(
        onPressed: _busy ? null : _locate,
        icon: const Icon(Icons.my_location),
        label: Text(_busy ? 'Konum alınıyor…' : 'Konumumu kullan'),
      ),
      if (_message != null)
        Padding(padding: const EdgeInsets.only(top: 4), child: Text(_message!)),
      const SizedBox(height: 12),
    ],
  );
}
