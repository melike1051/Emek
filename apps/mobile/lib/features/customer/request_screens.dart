import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../api/api_error.dart';
import '../../api/customer_api.dart';
import '../../api/idempotency_key.dart';
import '../../domain/booking_rules.dart';
import '../../widgets/common.dart';
import '../../widgets/error_view.dart';
import 'customer_providers.dart';
import 'request_form.dart';

/// `/talep/:id` — ayrıştırma sonucunu gözden geçir (düşük güven uyarısı) → eşleştir.
/// Eşleştirme rezervasyonu **kendisi** oluşturur (web adım 3 notu).
class RequestReviewScreen extends ConsumerStatefulWidget {
  const RequestReviewScreen({super.key, required this.requestId});
  final String requestId;

  @override
  ConsumerState<RequestReviewScreen> createState() =>
      _RequestReviewScreenState();
}

class _RequestReviewScreenState extends ConsumerState<RequestReviewScreen> {
  /// Aynı talebin eşleştirme tekrarı aynı anahtarı taşır (gövde yok → imza sabit).
  final _key = IdempotencyKey();
  bool _editing = false;
  bool _busy = false;
  Object? _error;

  void _toResult() => context.go('/talep/${widget.requestId}/eslesme');

  Future<void> _match() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref
          .read(customerApiProvider)
          .match(widget.requestId, _key.current());
      _key.rotate();
      if (mounted) _toResult();
    } on ApiError catch (error) {
      // Talep zaten eşleştirilmişse hata değil: sonuca gidilir.
      if (error.code == 'MATCHING_ALREADY_COMPLETED') {
        if (mounted) _toResult();
      } else if (mounted) {
        setState(() => _error = error);
      }
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final request = ref.watch(requestProvider(widget.requestId));
    final services =
        ref.watch(servicesProvider).value ?? const <ServiceDefinition>[];
    return Scaffold(
      appBar: AppBar(title: const Text('Talebiniz')),
      body: AsyncBody(
        value: request,
        onRetry: () => ref.invalidate(requestProvider(widget.requestId)),
        data: (data) {
          if (_editing) {
            return ListView(
              padding: const EdgeInsets.all(16),
              children: [
                SectionCard(
                  title: 'Talebi düzelt',
                  children: [
                    const Text(
                      'Düzeltilen bilgilerle yeni bir talep oluşturulur.',
                    ),
                    const SizedBox(height: 12),
                    RequestForm(
                      addressId: data.addressId,
                      initial: data,
                      onCreated: (created) =>
                          context.pushReplacement('/talep/${created.id}'),
                    ),
                    TextButton(
                      onPressed: () => setState(() => _editing = false),
                      child: const Text('Vazgeç'),
                    ),
                  ],
                ),
              ],
            );
          }
          final service = services
              .where((s) => s.id == data.serviceId)
              .firstOrNull;
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              SectionCard(
                title: data.parserVersion != null ? 'Anladığımız' : 'Talebiniz',
                children: [
                  if (needsReview(data.parserConfidence))
                    const Notice(
                      'Talebinizi doğru anladığımızdan emin değiliz. Lütfen bilgileri kontrol '
                      'edin; gerekirse düzeltin.',
                    ),
                  _Fact('Hizmet', service?.name ?? '…'),
                  _Fact(
                    'Zaman aralığı',
                    formatRange(data.preferredStart, data.preferredEnd),
                  ),
                  _Fact('Süre', '${data.durationMinutes} dakika'),
                ],
              ),
              if (_error != null) ...[
                ErrorView(error: _error!),
                const SizedBox(height: 12),
              ],
              BusyButton(
                label: 'Sağlayıcı bul',
                busy: _busy,
                onPressed: _match,
              ),
              TextButton(
                onPressed: _busy ? null : () => setState(() => _editing = true),
                child: const Text('Bilgileri düzelt'),
              ),
            ],
          );
        },
      ),
    );
  }
}

/// `/talep/:id/eslesme` — seçilen sağlayıcı + gerekçeler; aday yoksa boş durum.
class MatchResultScreen extends ConsumerWidget {
  const MatchResultScreen({super.key, required this.requestId});
  final String requestId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final result = ref.watch(matchResultProvider(requestId));
    return Scaffold(
      appBar: AppBar(title: const Text('Eşleşme')),
      body: AsyncBody(
        value: result,
        onRetry: () => ref.invalidate(matchResultProvider(requestId)),
        data: (data) {
          if (!data.matched || data.bookingId == null) {
            return ListView(
              padding: const EdgeInsets.all(24),
              children: [
                Text(
                  'Şu an uygun sağlayıcı bulamadık',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 8),
                const Text(
                  'Farklı bir zaman aralığı ya da tarih seçerek yeni bir talep '
                  'oluşturabilirsiniz.',
                ),
                const SizedBox(height: 16),
                OutlinedButton(
                  onPressed: () => context.go('/'),
                  child: const Text('Yeni talep oluştur'),
                ),
              ],
            );
          }
          final reasons = data.explanation
              .map((e) => explanationText(e.code, e.value))
              .whereType<String>()
              .toList();
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              SectionCard(
                title: 'Sizin için seçtiğimiz sağlayıcı',
                children: [
                  Text(
                    data.providerName ?? 'Sağlayıcı',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  if (data.scheduledStart != null && data.scheduledEnd != null)
                    Text(formatRange(data.scheduledStart!, data.scheduledEnd!)),
                  const SizedBox(height: 12),
                  if (data.degraded)
                    const Notice(
                      'Eşleştirme sınırlı modda yapıldı; sonuç yine de uygunluk kurallarından '
                      'geçti.',
                    ),
                  if (reasons.isNotEmpty) ...[
                    const StatusBadge(
                      StatusView('Neden bu sağlayıcı?', Tone.trust),
                    ),
                    const SizedBox(height: 8),
                    for (final reason in reasons)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 4),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text('•  '),
                            Expanded(child: Text(reason)),
                          ],
                        ),
                      ),
                  ],
                ],
              ),
              const Text(
                'Sağlayıcı talebinizi onayladıktan sonra ödeme adımına geçeceksiniz.',
              ),
              const SizedBox(height: 12),
              FilledButton(
                onPressed: () => context.go('/randevular/${data.bookingId}'),
                child: const Text('Randevuya git'),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _Fact extends StatelessWidget {
  const _Fact(this.label, this.value);
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: Theme.of(context).textTheme.bodySmall),
        Text(value, style: Theme.of(context).textTheme.bodyLarge),
      ],
    ),
  );
}
