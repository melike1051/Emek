import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../api/customer_api.dart';
import '../../api/idempotency_key.dart';
import '../../api/provider_api.dart';
import '../../domain/booking_rules.dart';
import '../../domain/provider_rules.dart';
import '../../widgets/common.dart';
import '../../widgets/error_view.dart';
import '../customer/customer_providers.dart';
import 'provider_providers.dart';

String _serviceName(WidgetRef ref, String serviceId) =>
    (ref.watch(servicesProvider).value ?? const <ServiceDefinition>[])
        .where((s) => s.id == serviceId)
        .firstOrNull
        ?.name ??
    'Hizmet';

/// `/panel/randevular` — sağlayıcı olarak verilen randevular (aktif önce, tarihe göre).
class ProviderBookingsScreen extends ConsumerWidget {
  const ProviderBookingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final bookings = ref.watch(providerBookingsProvider);
    return RefreshIndicator(
      onRefresh: () async => ref.invalidate(bookingsProvider),
      child: AsyncBody(
        value: bookings,
        onRetry: () => ref.invalidate(bookingsProvider),
        data: (list) {
          final active = list.where((b) => isActiveBooking(b.status)).toList()
            ..sort((a, b) => a.scheduledStart.compareTo(b.scheduledStart));
          final past = list.where((b) => !isActiveBooking(b.status)).toList()
            ..sort((a, b) => b.scheduledStart.compareTo(a.scheduledStart));
          return ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(16),
            children: [
              if (list.isEmpty)
                const Padding(
                  padding: EdgeInsets.all(24),
                  child: Text(
                    'Henüz randevunuz yok. Onaylandığınızda talepler burada görünür.',
                  ),
                ),
              if (active.isNotEmpty) ...[
                Text('Aktif', style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 8),
                for (final b in active) _Tile(b),
              ],
              if (past.isNotEmpty) ...[
                const SizedBox(height: 16),
                Text('Geçmiş', style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 8),
                for (final b in past) _Tile(b),
              ],
            ],
          );
        },
      ),
    );
  }
}

class _Tile extends ConsumerWidget {
  const _Tile(this.booking);
  final Booking booking;

  @override
  Widget build(BuildContext context, WidgetRef ref) => Card(
    margin: const EdgeInsets.only(bottom: 8),
    child: ListTile(
      onTap: () => context.push('/panel/randevular/${booking.id}'),
      title: Text(_serviceName(ref, booking.serviceId)),
      subtitle: Padding(
        padding: const EdgeInsets.only(top: 4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(formatRange(booking.scheduledStart, booking.scheduledEnd)),
            const SizedBox(height: 6),
            StatusBadge(providerBookingStatusView(booking.status)),
          ],
        ),
      ),
      trailing: const Icon(Icons.chevron_right),
    ),
  );
}

/// `/panel/randevular/:id` — yanıt (kabul/ret), hizmet günü adımları, kanıt, iptal.
class ProviderBookingDetailScreen extends ConsumerWidget {
  const ProviderBookingDetailScreen({super.key, required this.bookingId});
  final String bookingId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final booking = ref.watch(bookingProvider(bookingId));
    return Scaffold(
      appBar: AppBar(title: const Text('Randevu')),
      body: RefreshIndicator(
        onRefresh: () async => _invalidate(ref, bookingId),
        child: AsyncBody(
          value: booking,
          onRetry: () => ref.invalidate(bookingProvider(bookingId)),
          data: (data) {
            final actions = ProviderActions.of(data.status);
            return ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.all(16),
              children: [
                SectionCard(
                  title: 'Randevu',
                  trailing: StatusBadge(providerBookingStatusView(data.status)),
                  children: [
                    Text(
                      _serviceName(ref, data.serviceId),
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(height: 4),
                    Text(formatRange(data.scheduledStart, data.scheduledEnd)),
                    Text(formatMoney(data.priceMinor, data.currency)),
                    const SizedBox(height: 8),
                    _ServiceAddress(
                      bookingId: bookingId,
                      visibility: actions.address,
                    ),
                    if (actions.hasSafetySession) ...[
                      const SizedBox(height: 12),
                      OutlinedButton.icon(
                        onPressed: () =>
                            context.push('/panel/randevular/$bookingId/oturum'),
                        icon: const Icon(Icons.shield_outlined),
                        label: const Text('Güvenlik & oturum'),
                      ),
                    ],
                  ],
                ),
                if (actions.canRespond) _RespondCard(bookingId: bookingId),
                if (actions.next != null)
                  _NextStepCard(bookingId: bookingId, step: actions.next!),
                _EvidenceCard(
                  bookingId: bookingId,
                  uploadable: actions.uploadable,
                ),
                if (actions.canCancel) _CancelCard(bookingId: bookingId),
              ],
            );
          },
        ),
      ),
    );
  }
}

/// Hizmet adresi (R-102). Pencere dışında istek atılmaz; harita yalnız dokununca açılır ve
/// koordinat ancak o zaman dış uygulamaya gider.
class _ServiceAddress extends ConsumerWidget {
  const _ServiceAddress({required this.bookingId, required this.visibility});
  final String bookingId;
  final AddressVisibility visibility;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    switch (visibility) {
      case AddressVisibility.afterPayment:
        return const Text(
          'Hizmet adresi, müşteri ödemeyi onaylayıp randevu planlandığında görünür.',
        );
      case AddressVisibility.closed:
        return const Text(
          'Randevu kapandığı için hizmet adresi artık gösterilmiyor.',
        );
      case AddressVisibility.visible:
        break;
    }
    final address = ref.watch(bookingAddressProvider(bookingId));
    return address.when(
      loading: () => const LinearProgressIndicator(),
      error: (error, _) => ErrorView(
        error: error,
        onRetry: () => ref.invalidate(bookingAddressProvider(bookingId)),
      ),
      data: (data) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(data.line),
          Text('${data.district} / ${data.city}'),
          TextButton.icon(
            onPressed: () => launchUrl(
              Uri.https('www.google.com', '/maps/search/', {
                'api': '1',
                'query': '${data.latitude},${data.longitude}',
              }),
              mode: LaunchMode.externalApplication,
            ),
            icon: const Icon(Icons.map_outlined),
            label: const Text('Haritada aç'),
          ),
        ],
      ),
    );
  }
}

void _invalidate(WidgetRef ref, String bookingId) {
  invalidateBooking(ref, bookingId);
  ref.invalidate(documentsProvider(bookingId));
  ref.invalidate(bookingAddressProvider(bookingId));
}

/// Randevu komutu: aynı gövdenin tekrarı aynı anahtar, gövde değişince yeni anahtar.
mixin _Command<T extends ConsumerStatefulWidget> on ConsumerState<T> {
  final key = IdempotencyKey();
  bool busy = false;
  Object? error;

  Future<bool> runCommand(
    String bookingId,
    Future<void> Function(String key) action, {
    String signature = '',
  }) async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await action(key.current(signature));
      key.rotate();
      if (mounted) _invalidate(ref, bookingId);
      return true;
    } catch (caught) {
      if (mounted) setState(() => error = caught);
      return false;
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }
}

class _RespondCard extends ConsumerStatefulWidget {
  const _RespondCard({required this.bookingId});
  final String bookingId;

  @override
  ConsumerState<_RespondCard> createState() => _RespondCardState();
}

class _RespondCardState extends ConsumerState<_RespondCard> with _Command {
  final _reason = TextEditingController();

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SectionCard(
    title: 'Yeni randevu talebi',
    children: [
      const Text(
        'Bu saatte hizmet verebilecek misiniz? Onayladığınızda müşteriden ödeme yetkisi istenir.',
      ),
      const SizedBox(height: 12),
      if (error != null) ...[
        ErrorView(error: error!),
        const SizedBox(height: 12),
      ],
      ConfirmStep(
        label: 'Randevuyu kabul et',
        confirmLabel: 'Evet, kabul ediyorum',
        busy: busy,
        onConfirm: () => runCommand(
          widget.bookingId,
          (k) => ref.read(providerApiProvider).confirm(widget.bookingId, k),
          signature: 'confirm',
        ),
      ),
      const SizedBox(height: 8),
      // Ret ayrı bir uç değildir: PROVIDER_PENDING'de gerekçeli iptal.
      ConfirmStep(
        label: 'Reddet',
        confirmLabel: 'Randevuyu reddet',
        danger: true,
        busy: busy,
        onConfirm: () {
          final reason = _reason.text.trim();
          runCommand(
            widget.bookingId,
            (k) => ref
                .read(customerApiProvider)
                .cancel(widget.bookingId, reason, k),
            signature: 'decline:$reason',
          );
        },
        child: TextField(
          controller: _reason,
          maxLength: 160,
          decoration: const InputDecoration(
            labelText: 'Gerekçe (isteğe bağlı)',
          ),
        ),
      ),
    ],
  );
}

class _NextStepCard extends ConsumerStatefulWidget {
  const _NextStepCard({required this.bookingId, required this.step});
  final String bookingId;
  final NextStep step;

  @override
  ConsumerState<_NextStepCard> createState() => _NextStepCardState();
}

class _NextStepCardState extends ConsumerState<_NextStepCard> with _Command {
  @override
  Widget build(BuildContext context) => SectionCard(
    title: 'Sıradaki adım',
    children: [
      Text(widget.step.hint),
      const SizedBox(height: 12),
      if (error != null) ...[
        ErrorView(error: error!),
        const SizedBox(height: 12),
      ],
      // Anahtar hedef duruma bağlı: bir adım bitince sonraki adımın onayı sıfırdan başlar.
      ConfirmStep(
        key: ValueKey(widget.step.to),
        label: widget.step.label,
        confirmLabel: widget.step.confirmLabel,
        busy: busy,
        onConfirm: () => runCommand(
          widget.bookingId,
          (k) => ref
              .read(providerApiProvider)
              .transition(widget.bookingId, widget.step.to, k),
          signature: widget.step.to,
        ),
      ),
    ],
  );
}

class _CancelCard extends ConsumerStatefulWidget {
  const _CancelCard({required this.bookingId});
  final String bookingId;

  @override
  ConsumerState<_CancelCard> createState() => _CancelCardState();
}

class _CancelCardState extends ConsumerState<_CancelCard> with _Command {
  final _reason = TextEditingController();

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 24),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text(
          'Son dakika iptalleri müşteriyi zor durumda bırakır. Hizmet başladıktan sonra iptal '
          'yalnızca destek ekibi üzerinden yapılabilir.',
        ),
        const SizedBox(height: 8),
        if (error != null) ...[
          ErrorView(error: error!),
          const SizedBox(height: 12),
        ],
        ConfirmStep(
          label: 'Randevuyu iptal et',
          confirmLabel: 'İptal et',
          danger: true,
          busy: busy,
          onConfirm: () {
            final reason = _reason.text.trim();
            runCommand(
              widget.bookingId,
              (k) => ref
                  .read(customerApiProvider)
                  .cancel(widget.bookingId, reason, k),
              signature: reason,
            );
          },
          child: TextField(
            controller: _reason,
            maxLength: 160,
            decoration: const InputDecoration(
              labelText: 'İptal gerekçesi (isteğe bağlı)',
            ),
          ),
        ),
      ],
    ),
  );
}

/// Kanıt fotoğrafı seçici — test için enjekte edilebilir.
typedef PickedEvidence = ({Uint8List bytes, String contentType});
typedef EvidencePicker = Future<PickedEvidence?> Function(ImageSource source);

final evidencePickerProvider = Provider<EvidencePicker>(
  (ref) => _pickWithImagePicker,
);

Future<PickedEvidence?> _pickWithImagePicker(ImageSource source) async {
  // imageQuality → JPEG'e yeniden sıkıştırılır (iOS HEIC backend'de kabul edilmez).
  // TODO(legal): EXIF üst verisi (GPS dahil) korunabilir — image_picker Android'de EXIF'i
  // kopyalar. Müşteri evinin koordinatı fotoğrafta taşınabilir (KVKK veri minimizasyonu, R-109).
  final file = await ImagePicker().pickImage(
    source: source,
    imageQuality: 85,
    maxWidth: 2560,
  );
  if (file == null) return null;
  return (bytes: await file.readAsBytes(), contentType: 'image/jpeg');
}

class _EvidenceCard extends ConsumerStatefulWidget {
  const _EvidenceCard({required this.bookingId, required this.uploadable});
  final String bookingId;
  final List<String> uploadable;

  @override
  ConsumerState<_EvidenceCard> createState() => _EvidenceCardState();
}

class _EvidenceCardState extends ConsumerState<_EvidenceCard> {
  bool _busy = false;
  Object? _error;

  /// Kayıt açılmış ama yükleme/onay tamamlanmamış dosya: tekrar denemede aynı kayıt kullanılır.
  ({PendingUpload pending, String type, Uint8List bytes, String contentType})?
  _resume;

  Future<void> _upload(String type, ImageSource source) async {
    final picked = await ref.read(evidencePickerProvider)(source);
    if (picked == null) return;
    await _send(type, picked.bytes, picked.contentType, null);
  }

  Future<void> _send(
    String type,
    Uint8List bytes,
    String contentType,
    PendingUpload? resume,
  ) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    PendingUpload? registered = resume;
    try {
      await ref
          .read(providerApiProvider)
          .uploadEvidence(
            bookingId: widget.bookingId,
            documentType: type,
            contentType: contentType,
            bytes: bytes,
            resume: resume,
            onRegistered: (p) => registered = p,
          );
      _resume = null;
      if (mounted) ref.invalidate(documentsProvider(widget.bookingId));
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error;
        _resume = registered == null
            ? null
            : (
                pending: registered!,
                type: type,
                bytes: bytes,
                contentType: contentType,
              );
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final docs = ref.watch(documentsProvider(widget.bookingId));
    final uploaded = (docs.value ?? const <EvidenceDocument>[])
        .where((d) => d.uploaded)
        .toList();
    if (uploaded.isEmpty && widget.uploadable.isEmpty) {
      return const SizedBox.shrink();
    }
    return SectionCard(
      title: 'Dijital ispat',
      children: [
        if (uploaded.isEmpty) const Text('Henüz dosya eklenmedi.'),
        for (final doc in uploaded)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.verified_outlined),
            title: Text(
              documentTypeLabels[doc.documentType] ?? doc.documentType,
            ),
            subtitle: Text(
              '${formatDateTime(doc.createdAt)} · SHA-256 ${doc.sha256?.substring(0, 12) ?? ''}…',
            ),
          ),
        if (_error != null) ...[
          ErrorView(
            error: _error!,
            onRetry: _resume == null
                ? null
                : () => _send(
                    _resume!.type,
                    _resume!.bytes,
                    _resume!.contentType,
                    _resume!.pending,
                  ),
          ),
          const SizedBox(height: 12),
        ],
        if (_busy) const LinearProgressIndicator(),
        for (final type in widget.uploadable) ...[
          const SizedBox(height: 8),
          Text('“${documentTypeLabels[type]}” fotoğrafı'),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _busy
                      ? null
                      : () => _upload(type, ImageSource.camera),
                  icon: const Icon(Icons.photo_camera_outlined),
                  label: const Text('Çek'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _busy
                      ? null
                      : () => _upload(type, ImageSource.gallery),
                  icon: const Icon(Icons.photo_library_outlined),
                  label: const Text('Galeriden'),
                ),
              ),
            ],
          ),
        ],
      ],
    );
  }
}
