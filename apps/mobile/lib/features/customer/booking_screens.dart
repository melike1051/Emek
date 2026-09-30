import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../api/api_error.dart';
import '../../api/customer_api.dart';
import '../../api/idempotency_key.dart';
import '../../domain/booking_rules.dart';
import '../../session/providers.dart';
import '../../theme/theme.dart';
import '../../widgets/common.dart';
import '../../widgets/error_view.dart';
import 'customer_providers.dart';

String _serviceName(WidgetRef ref, String serviceId) =>
    (ref.watch(servicesProvider).value ?? const <ServiceDefinition>[])
        .where((s) => s.id == serviceId)
        .firstOrNull
        ?.name ??
    'Hizmet';

/// `/randevular` — aktif / geçmiş.
class BookingsScreen extends ConsumerWidget {
  const BookingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final bookings = ref.watch(bookingsProvider);
    return RefreshIndicator(
      onRefresh: () => ref.refresh(bookingsProvider.future),
      child: AsyncBody(
        value: bookings,
        onRetry: () => ref.invalidate(bookingsProvider),
        data: (all) {
          // Aynı hesap sağlayıcı da olabilir: bu ekran yalnız müşteri olarak alınanları gösterir
          // (sağlayıcı işleri panelde). Web ile aynı.
          final userId = ref.watch(sessionProvider).value?.userId;
          final list = all.where((b) => b.customerId == userId).toList();
          final active = list.where((b) => isActiveBooking(b.status)).toList();
          final past = list.where((b) => !isActiveBooking(b.status)).toList();
          return ListView(
            // Kısa içerikte de aşağı çekerek yenileme çalışsın.
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(16),
            children: [
              if (list.isEmpty)
                const Padding(
                  padding: EdgeInsets.all(24),
                  child: Text(
                    'Henüz randevunuz yok. Keşfet sekmesinden talep oluşturun.',
                  ),
                ),
              if (active.isNotEmpty) ...[
                Text('Aktif', style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 8),
                for (final booking in active) _BookingTile(booking),
              ],
              if (past.isNotEmpty) ...[
                const SizedBox(height: 16),
                Text('Geçmiş', style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 8),
                for (final booking in past) _BookingTile(booking),
              ],
            ],
          );
        },
      ),
    );
  }
}

class _BookingTile extends ConsumerWidget {
  const _BookingTile(this.booking);
  final Booking booking;

  @override
  Widget build(BuildContext context, WidgetRef ref) => Card(
    margin: const EdgeInsets.only(bottom: 8),
    child: ListTile(
      onTap: () => context.push('/randevular/${booking.id}'),
      title: Text(_serviceName(ref, booking.serviceId)),
      subtitle: Padding(
        padding: const EdgeInsets.only(top: 4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(formatRange(booking.scheduledStart, booking.scheduledEnd)),
            const SizedBox(height: 6),
            StatusBadge(bookingStatusView(booking.status)),
          ],
        ),
      ),
      trailing: const Icon(Icons.chevron_right),
    ),
  );
}

/// `/randevular/:id` — durum, ödeme, hizmet onayı, değerlendirme, itiraz, iptal, geçmiş.
class BookingDetailScreen extends ConsumerWidget {
  const BookingDetailScreen({super.key, required this.bookingId});
  final String bookingId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final booking = ref.watch(bookingProvider(bookingId));
    return Scaffold(
      appBar: AppBar(title: const Text('Randevu')),
      body: RefreshIndicator(
        onRefresh: () async => invalidateBooking(ref, bookingId),
        child: AsyncBody(
          value: booking,
          onRetry: () => ref.invalidate(bookingProvider(bookingId)),
          data: (data) {
            final actions = CustomerActions.of(data.status);
            return ListView(
              // Kısa içerikte de aşağı çekerek yenileme çalışsın.
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.all(16),
              children: [
                SectionCard(
                  title: 'Randevu',
                  trailing: StatusBadge(bookingStatusView(data.status)),
                  children: [
                    Text(
                      _serviceName(ref, data.serviceId),
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(height: 4),
                    Text(formatRange(data.scheduledStart, data.scheduledEnd)),
                    Text(formatMoney(data.priceMinor, data.currency)),
                    if (actions.hasSafetySession) ...[
                      const SizedBox(height: 12),
                      OutlinedButton.icon(
                        onPressed: () =>
                            context.push('/randevular/$bookingId/guvenlik'),
                        icon: const Icon(Icons.shield_outlined),
                        label: const Text('Güvenlik & oturum'),
                      ),
                    ],
                  ],
                ),
                _PaymentCard(booking: data),
                if (actions.canConfirmService)
                  _ConfirmServiceCard(bookingId: bookingId),
                if (actions.canReview) _ReviewCard(bookingId: bookingId),
                _DisputesCard(
                  bookingId: bookingId,
                  canOpen: actions.canDispute,
                ),
                _HistoryCard(bookingId: bookingId),
                if (actions.canCancel) _CancelCard(bookingId: bookingId),
              ],
            );
          },
        ),
      ),
    );
  }
}

/// Bir komutun ortak durumu: meşgul, hata ve gövdeye bağlı idempotency anahtarı.
mixin _Command<T extends ConsumerStatefulWidget> on ConsumerState<T> {
  final key = IdempotencyKey();
  bool busy = false;
  Object? error;

  /// [signature]: gövdenin kanonik metni; değişirse yeni anahtar (ADR-0025 §4).
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
      if (mounted) invalidateBooking(ref, bookingId);
      return true;
    } catch (caught) {
      if (mounted) setState(() => error = caught);
      return false;
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }
}

class _PaymentCard extends ConsumerStatefulWidget {
  const _PaymentCard({required this.booking});
  final Booking booking;

  @override
  ConsumerState<_PaymentCard> createState() => _PaymentCardState();
}

class _PaymentCardState extends ConsumerState<_PaymentCard> with _Command {
  @override
  Widget build(BuildContext context) {
    final booking = widget.booking;
    final payment = ref.watch(paymentProvider(booking.id));
    // Başka sekmede zaten yetkilendirildiyse hata değil: durum tazelenir.
    final alreadyAuthorized =
        error is ApiError &&
        (error! as ApiError).code == 'PAYMENT_ALREADY_AUTHORIZED';
    return SectionCard(
      title: 'Ödeme',
      children: [
        AsyncBody(
          value: payment,
          onRetry: () => ref.invalidate(paymentProvider(booking.id)),
          data: (data) => data == null
              ? const Text(
                  'Sağlayıcı randevuyu onayladığında ödemeyi yetkilendirmeniz istenecek. '
                  'O zamana kadar kartınızdan tutar alınmaz.',
                )
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    StatusBadge(paymentStatusView(data.status)),
                    const SizedBox(height: 6),
                    Text(
                      'Tutar: ${formatMoney(data.amountMinor, data.currency)}',
                    ),
                    if (data.refundedMinor != '0')
                      Text(
                        'İade: ${formatMoney(data.refundedMinor, data.currency)}',
                      ),
                    if (data.status == 'AUTHORIZATION_EXPIRED') ...[
                      const SizedBox(height: 8),
                      const Notice(
                        'Ödeme yetkisinin süresi doldu. Yeniden yetkilendirme destek ekibimiz '
                        'tarafından başlatılır; sizinle iletişime geçeceğiz.',
                      ),
                    ],
                  ],
                ),
        ),
        if (booking.status == 'CONFIRMED') ...[
          const SizedBox(height: 12),
          const Text(
            'Tutar lisanslı ödeme kuruluşu tarafından kartınızda bloke edilir; hizmet '
            'tamamlanıp onaylanana kadar sağlayıcıya aktarılmaz.',
          ),
          const SizedBox(height: 12),
          if (error != null && !alreadyAuthorized) ...[
            ErrorView(error: error!),
            const SizedBox(height: 12),
          ],
          BusyButton(
            label:
                '${formatMoney(booking.priceMinor, booking.currency)} ödemeyi onayla',
            busy: busy,
            onPressed: () async {
              final ok = await runCommand(
                booking.id,
                (k) => ref
                    .read(customerApiProvider)
                    .authorizePayment(booking.id, k),
              );
              // Hata çağrıdan **sonra** okunur (build'deki değer eskidir).
              final failure = error;
              if (!ok &&
                  mounted &&
                  failure is ApiError &&
                  failure.code == 'PAYMENT_ALREADY_AUTHORIZED') {
                invalidateBooking(ref, booking.id);
              }
            },
          ),
        ],
      ],
    );
  }
}

class _ConfirmServiceCard extends ConsumerStatefulWidget {
  const _ConfirmServiceCard({required this.bookingId});
  final String bookingId;

  @override
  ConsumerState<_ConfirmServiceCard> createState() =>
      _ConfirmServiceCardState();
}

class _ConfirmServiceCardState extends ConsumerState<_ConfirmServiceCard>
    with _Command {
  @override
  Widget build(BuildContext context) => SectionCard(
    title: 'Hizmet tamamlandı mı?',
    children: [
      const Text(
        'Sağlayıcı hizmeti bitirdiğini bildirdi. Onayınızdan sonra itiraz penceresi başlar; '
        'bir sorun varsa onaylamadan önce itiraz açabilirsiniz.',
      ),
      const SizedBox(height: 12),
      if (error != null) ...[
        ErrorView(error: error!),
        const SizedBox(height: 12),
      ],
      ConfirmStep(
        label: 'Hizmeti onayla',
        confirmLabel: 'Evet, hizmet tamamlandı',
        busy: busy,
        onConfirm: () => runCommand(
          widget.bookingId,
          (k) =>
              ref.read(customerApiProvider).confirmService(widget.bookingId, k),
        ),
      ),
    ],
  );
}

class _ReviewCard extends ConsumerStatefulWidget {
  const _ReviewCard({required this.bookingId});
  final String bookingId;

  @override
  ConsumerState<_ReviewCard> createState() => _ReviewCardState();
}

class _ReviewCardState extends ConsumerState<_ReviewCard> with _Command {
  final _comment = TextEditingController();
  int _rating = 0;
  bool _done = false;

  @override
  void dispose() {
    _comment.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final already =
        error is ApiError &&
        (error! as ApiError).code == 'REVIEW_ALREADY_EXISTS';
    if (_done || already) {
      return const SectionCard(
        title: 'Değerlendirme',
        children: [Text('Değerlendirmeniz için teşekkürler.')],
      );
    }
    return SectionCard(
      title: 'Değerlendirme',
      children: [
        Semantics(
          label: 'Puan',
          child: Row(
            children: [
              for (var value = 1; value <= 5; value++)
                IconButton(
                  tooltip: '$value yıldız',
                  isSelected: _rating == value,
                  icon: Icon(
                    value <= _rating ? Icons.star : Icons.star_border,
                    color: const Color(0xFFB5562B),
                  ),
                  onPressed: busy
                      ? null
                      : () => setState(() => _rating = value),
                ),
            ],
          ),
        ),
        TextField(
          controller: _comment,
          maxLength: 2000,
          maxLines: 3,
          decoration: const InputDecoration(
            labelText: 'Yorumunuz (isteğe bağlı)',
          ),
        ),
        if (error != null) ...[
          ErrorView(error: error!),
          const SizedBox(height: 12),
        ],
        BusyButton(
          label: 'Değerlendirmeyi gönder',
          busy: busy,
          onPressed: _rating < 1
              ? null
              : () async {
                  final comment = _comment.text.trim();
                  final body = {
                    'rating': _rating,
                    if (comment.isNotEmpty) 'comment': comment,
                  };
                  final ok = await runCommand(
                    widget.bookingId,
                    (k) => ref
                        .read(customerApiProvider)
                        .createReview(widget.bookingId, body, k),
                    signature: jsonEncode(body),
                  );
                  if (ok && mounted) setState(() => _done = true);
                },
        ),
      ],
    );
  }
}

class _DisputesCard extends ConsumerStatefulWidget {
  const _DisputesCard({required this.bookingId, required this.canOpen});
  final String bookingId;
  final bool canOpen;

  @override
  ConsumerState<_DisputesCard> createState() => _DisputesCardState();
}

class _DisputesCardState extends ConsumerState<_DisputesCard> with _Command {
  final _description = TextEditingController();
  String _reason = 'SERVICE_QUALITY';
  bool _opening = false;

  @override
  void dispose() {
    _description.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final disputes =
        ref.watch(disputesProvider(widget.bookingId)).value ??
        const <Dispute>[];
    final hasOpen = disputes.any((d) => d.isOpen);
    if (disputes.isEmpty && !widget.canOpen) return const SizedBox.shrink();
    return SectionCard(
      title: 'İtiraz',
      children: [
        for (final dispute in disputes) ...[
          Row(
            children: [
              Expanded(
                child: Text(
                  disputeReasonLabels[dispute.reason] ?? dispute.reason,
                ),
              ),
              StatusBadge(
                StatusView(
                  disputeStatusLabels[dispute.status] ?? dispute.status,
                  dispute.isOpen ? Tone.highlight : Tone.neutral,
                ),
              ),
            ],
          ),
          if (dispute.description != null) Text(dispute.description!),
          if (dispute.resolution != null) Text('Sonuç: ${dispute.resolution}'),
          const Divider(),
        ],
        if (widget.canOpen && !hasOpen && !_opening)
          OutlinedButton(
            onPressed: () => setState(() => _opening = true),
            child: const Text('Sorun bildir'),
          ),
        if (widget.canOpen && !hasOpen && _opening) ...[
          DropdownButtonFormField<String>(
            initialValue: _reason,
            decoration: const InputDecoration(labelText: 'Neden'),
            items: [
              for (final entry in disputeReasonLabels.entries)
                DropdownMenuItem(value: entry.key, child: Text(entry.value)),
            ],
            onChanged: (value) => setState(() => _reason = value ?? _reason),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _description,
            maxLength: 2000,
            maxLines: 3,
            decoration: const InputDecoration(
              labelText: 'Açıklama (isteğe bağlı)',
            ),
          ),
          if (error != null) ...[
            ErrorView(error: error!),
            const SizedBox(height: 12),
          ],
          ConfirmStep(
            label: 'İtirazı gönder',
            confirmLabel: 'Evet, itiraz et',
            danger: true,
            busy: busy,
            onConfirm: () async {
              final description = _description.text.trim();
              final body = {
                'reason': _reason,
                if (description.isNotEmpty) 'description': description,
              };
              final ok = await runCommand(
                widget.bookingId,
                (k) => ref
                    .read(customerApiProvider)
                    .openDispute(widget.bookingId, body, k),
                signature: jsonEncode(body),
              );
              if (ok && mounted) setState(() => _opening = false);
            },
          ),
        ],
      ],
    );
  }
}

class _HistoryCard extends ConsumerWidget {
  const _HistoryCard({required this.bookingId});
  final String bookingId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final history = ref.watch(historyProvider(bookingId)).value;
    if (history == null || history.isEmpty) return const SizedBox.shrink();
    return SectionCard(
      title: 'Zaman çizelgesi',
      children: [
        for (final entry in history.reversed)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Row(
              children: [
                Text(
                  formatDateTime(entry.createdAt),
                  style: const TextStyle(color: EmekColors.textMuted),
                ),
                const SizedBox(width: 12),
                Expanded(child: Text(bookingStatusView(entry.toStatus).label)),
              ],
            ),
          ),
      ],
    );
  }
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
