import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../api/customer_api.dart';
import '../../domain/booking_rules.dart';
import '../../theme/theme.dart';
import '../../widgets/common.dart';
import '../../widgets/error_view.dart';
import '../../telemetry/telemetry_card.dart';
import '../../telemetry/telemetry_controller.dart';
import '../customer/customer_providers.dart';

enum SafetyPerspective { customer, provider }

/// Taraf görünümü bilinçli olarak dardır (ADR-0019 §9): risk seviyesi/kurallar/konum yok.
/// Panik deterministik ve anlıktır: tek onay adımı, kategori **isteğe bağlı**, otomatik tekrar
/// yok ama buton hata sonrası hemen tekrar basılabilir — backend tekrarı tekilleştirir.
class SafetyScreen extends ConsumerStatefulWidget {
  const SafetyScreen({
    super.key,
    required this.bookingId,
    this.perspective = SafetyPerspective.customer,
  });
  final String bookingId;
  final SafetyPerspective perspective;

  @override
  ConsumerState<SafetyScreen> createState() => _SafetyScreenState();
}

const _sessionStatus = {
  'NOT_STARTED': 'Hizmet saatinde başlayacak',
  'PRE_SERVICE': 'Hizmet saatinde başlayacak',
  'ACTIVE': 'Hizmet oturumu aktif',
  'CLOSED': 'Oturum kapandı',
};

const _categories = [
  ('THREAT', 'Tehdit'),
  ('HEALTH', 'Sağlık'),
  ('OTHER', 'Diğer'),
];

class _SafetyScreenState extends ConsumerState<SafetyScreen>
    with WidgetsBindingObserver {
  Timer? _poll;
  bool _armed = false;
  String? _category;
  bool _busy = false;
  bool _raised = false;
  Object? _error;

  bool get _customer => widget.perspective == SafetyPerspective.customer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _startPolling();
  }

  /// Web ile aynı: oturum 30 sn'de bir tazelenir (panik bunu beklemez, kendi çağrısıdır).
  /// Yalnız uygulama ön plandayken: Android'de konum ön plan servisi süreci arka planda da
  /// canlı tutar; yoklama sürse kimsenin bakmadığı ekran için radyo uyanırdı.
  void _startPolling() {
    _poll?.cancel();
    _poll = Timer.periodic(
      const Duration(seconds: 30),
      (_) => ref.invalidate(safetySessionProvider(widget.bookingId)),
    );
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      // Dönüşte beklemeden tazele: arka plandayken oturum kapanmış olabilir.
      ref.invalidate(safetySessionProvider(widget.bookingId));
      _startPolling();
    } else {
      _poll?.cancel();
      _poll = null;
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _panic(SafetySession session) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref
          .read(customerApiProvider)
          .panic(session.sessionId, category: _category);
      if (!mounted) return;
      setState(() {
        _raised = true;
        _armed = false;
      });
      ref.invalidate(safetySessionProvider(widget.bookingId));
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(safetySessionProvider(widget.bookingId));
    if (!_customer) {
      // Sağlayıcı: oturum görünümü değiştikçe telemetri eşitlenir (tek kural:
      // `telemetryExpectedFromYou`). Müşteriden konum hiç toplanmaz.
      ref.listen(safetySessionProvider(widget.bookingId), (_, next) {
        if (next.hasValue) {
          ref.read(telemetryControllerProvider.notifier).sync(next.value);
        }
      });
    }
    return Scaffold(
      appBar: AppBar(title: const Text('Güvenlik')),
      body: AsyncBody(
        value: session,
        onRetry: () => ref.invalidate(safetySessionProvider(widget.bookingId)),
        data: (data) {
          if (data == null) {
            return ListView(
              padding: const EdgeInsets.all(24),
              children: [
                Text(
                  'Güvenlik oturumu henüz başlamadı',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 8),
                Text(
                  _customer
                      ? 'Oturum, hizmet günü sağlayıcı yola çıktığında otomatik açılır.'
                      : 'Oturum, randevu ekranında “Yola çıktım” dediğinizde otomatik açılır.',
                ),
                const SizedBox(height: 24),
                const _Call112(),
              ],
            );
          }
          final emergency = data.emergencyActive || _raised;
          final statusText = data.status == 'ARRIVAL_MONITORING'
              ? (_customer
                    ? 'Sağlayıcı yolda — varış izleniyor'
                    : 'Yoldasınız — varışınız izleniyor')
              : (_sessionStatus[data.status] ?? data.status);
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              SectionCard(
                title: 'Oturum',
                trailing: StatusBadge(
                  StatusView(
                    statusText,
                    data.isClosed ? Tone.neutral : Tone.trust,
                  ),
                ),
                children: [
                  Text(
                    _customer
                        ? 'Konum yalnızca aktif hizmet süresince ve yalnızca sağlayıcıdan '
                              'alınır; sizin konumunuz toplanmaz.'
                        : 'Konumunuz yalnızca bu hizmet süresince paylaşılır. Müşteri '
                              'konumunuzu görmez.',
                  ),
                ],
              ),
              if (!_customer && data.telemetryExpectedFromYou)
                TelemetryCard(sessionId: data.sessionId),
              if (emergency)
                Semantics(
                  liveRegion: true,
                  child: SectionCard(
                    title: 'Acil durum',
                    children: [
                      const StatusBadge(
                        StatusView('Acil durum kaydınız alındı', Tone.danger),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        'Operasyon ekibimiz bilgilendirildi.'
                        '${data.panicRaisedAt != null ? ' Kayıt: ${formatDateTime(data.panicRaisedAt!)}.' : ''}',
                      ),
                      const SizedBox(height: 8),
                      const Text(
                        'Hayati tehlike varsa hemen 112’yi arayın.',
                        style: TextStyle(fontWeight: FontWeight.w700),
                      ),
                      const SizedBox(height: 12),
                      const _Call112(),
                    ],
                  ),
                ),
              if (!data.isClosed && !emergency && !data.acceptsPanic)
                const SectionCard(
                  title: 'Acil durum',
                  children: [
                    Text(
                      'Acil durum bildirimi hizmet başladığında buradan açılır. Şu an acil bir '
                      'durum varsa hemen 112’yi arayın.',
                    ),
                    SizedBox(height: 12),
                    _Call112(),
                  ],
                ),
              if (!data.isClosed && !emergency && data.acceptsPanic)
                SectionCard(
                  title: 'Acil durum',
                  children: [
                    if (!_armed)
                      _PanicButton(
                        label: 'Acil durum',
                        onPressed: () => setState(() => _armed = true),
                      )
                    else ...[
                      const Text(
                        'Acil durum bildirilsin mi? Operasyon ekibi hemen devreye girer.',
                      ),
                      const SizedBox(height: 8),
                      Wrap(
                        spacing: 8,
                        children: [
                          for (final (value, label) in _categories)
                            ChoiceChip(
                              label: Text(label),
                              selected: _category == value,
                              onSelected: (on) =>
                                  setState(() => _category = on ? value : null),
                            ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      if (_error != null) ...[
                        ErrorView(error: _error!),
                        const SizedBox(height: 12),
                      ],
                      _PanicButton(
                        label: 'Evet, acil durum bildir',
                        busy: _busy,
                        onPressed: () => _panic(data),
                      ),
                      TextButton(
                        onPressed: _busy
                            ? null
                            : () => setState(() => _armed = false),
                        child: const Text('Vazgeç'),
                      ),
                    ],
                  ],
                ),
            ],
          );
        },
      ),
    );
  }
}

class _PanicButton extends StatelessWidget {
  const _PanicButton({
    required this.label,
    required this.onPressed,
    this.busy = false,
  });
  final String label;
  final bool busy;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => FilledButton(
    style: FilledButton.styleFrom(
      backgroundColor: EmekColors.danger,
      minimumSize: const Size.fromHeight(64),
      textStyle: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
    ),
    onPressed: busy ? null : onPressed,
    child: busy
        ? const SizedBox.square(
            dimension: 24,
            child: CircularProgressIndicator(
              color: Colors.white,
              strokeWidth: 2,
            ),
          )
        : Text(label),
  );
}

/// 112'yi doğrudan arar. Arama başlatılamazsa (ör. simülatör, tablet) numarayı gösterir.
class _Call112 extends StatelessWidget {
  const _Call112();

  @override
  Widget build(BuildContext context) => OutlinedButton.icon(
    icon: const Icon(Icons.call),
    label: const Text('112’yi ara'),
    onPressed: () async {
      bool launched;
      try {
        launched = await launchUrl(Uri(scheme: 'tel', path: '112'));
      } on Exception {
        launched = false;
      }
      if (!launched && context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Arama başlatılamadı. Lütfen 112’yi arayın.'),
          ),
        );
      }
    },
  );
}
