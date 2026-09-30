import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../api/customer_api.dart';
import '../../domain/booking_rules.dart';
import '../../domain/provider_rules.dart';
import '../../session/providers.dart';
import '../../session/session.dart';
import '../../widgets/common.dart';
import '../../widgets/error_view.dart';
import '../customer/customer_providers.dart';
import 'provider_providers.dart';

const _stateView = {
  ProviderState.draft: StatusView('Taslak', Tone.neutral),
  ProviderState.pendingReview: StatusView('İncelemede', Tone.highlight),
  ProviderState.approved: StatusView('Onaylandı', Tone.trust),
  ProviderState.rejected: StatusView('Reddedildi', Tone.danger),
  ProviderState.suspended: StatusView('Askıda', Tone.danger),
};

const _stateHint = {
  ProviderState.draft: 'Profilinizi tamamlayıp incelemeye gönderin.',
  ProviderState.pendingReview: 'Başvurunuz operasyon ekibinde inceleniyor.',
  ProviderState.approved: 'Eşleştirmede görünüyorsunuz.',
  ProviderState.rejected: 'Eksikleri tamamlayıp yeniden başvurabilirsiniz.',
  ProviderState.suspended: 'Hesabınız askıda; yeni eşleştirme almazsınız.',
};

/// `/panel` — profil durumu, hazırlık listesi + başvuru, sıradaki işler.
class ProviderHomeScreen extends ConsumerWidget {
  const ProviderHomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = ref.watch(sessionProvider).value?.provider;
    if (provider == null) return const SizedBox.shrink();
    return RefreshIndicator(
      onRefresh: () async {
        invalidateReadiness(ref);
        ref
          ..invalidate(identityVerifiedProvider)
          ..invalidate(bookingsProvider)
          ..invalidate(sessionProvider);
      },
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        children: [
          SectionCard(
            title: 'Profil',
            trailing: StatusBadge(_stateView[provider.state]!),
            children: [
              Text(
                provider.displayName,
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 4),
              Text(_stateHint[provider.state]!),
            ],
          ),
          _Readiness(provider: provider),
          const _Upcoming(),
        ],
      ),
    );
  }
}

class _Readiness extends ConsumerStatefulWidget {
  const _Readiness({required this.provider});
  final ProviderProfile provider;

  @override
  ConsumerState<_Readiness> createState() => _ReadinessState();
}

class _ReadinessState extends ConsumerState<_Readiness> {
  bool _busy = false;
  Object? _error;

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(providerApiProvider).submit();
      // Profil durumu oturumda yaşar: oturum yenilenir.
      ref.invalidate(sessionProvider);
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final services = ref.watch(myServicesProvider);
    final areas = ref.watch(myAreasProvider);
    final upcoming = ref.watch(upcomingAvailabilityProvider);
    final identity = ref.watch(identityVerifiedProvider);
    final failed = [
      services,
      areas,
      upcoming,
    ].where((v) => v.hasError).firstOrNull;
    if (failed != null) {
      return ErrorView(
        error: failed.error!,
        onRetry: () => invalidateReadiness(ref),
      );
    }
    if (!services.hasValue || !areas.hasValue || !upcoming.hasValue) {
      return const Padding(
        padding: EdgeInsets.all(24),
        child: Center(child: CircularProgressIndicator()),
      );
    }
    final items = readiness(
      bio: widget.provider.bio,
      hasActiveService: services.value!.any((s) => s.active),
      hasActiveArea: areas.value!.any((a) => a.active),
      upcomingAvailability: upcoming.value!.length,
      identityVerified: identity.value ?? false,
    );
    final state = widget.provider.state;
    final canSubmit =
        state == ProviderState.draft || state == ProviderState.rejected;
    final ready = canSubmitApplication(items);
    return SectionCard(
      title: 'Hazırlık',
      children: [
        for (final item in items)
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(item.label),
            trailing: StatusBadge(
              StatusView(
                item.done ? 'Tamam' : 'Eksik',
                item.done ? Tone.trust : Tone.neutral,
              ),
            ),
            onTap: item.route == null ? null : () => context.push(item.route!),
          ),
        if (identity.value == false)
          const Notice(
            'Kimliği doğrulanmamış sağlayıcılar eşleştirmeye dahil edilmez. Doğrulama adımı '
            'yakında buradan başlatılabilecek.',
          ),
        if (canSubmit) ...[
          if (_error != null) ...[
            ErrorView(error: _error!),
            const SizedBox(height: 12),
          ],
          if (!ready)
            const Text('Başvuruyu göndermek için eksik adımları tamamlayın.'),
          const SizedBox(height: 8),
          BusyButton(
            label: state == ProviderState.rejected
                ? 'Yeniden başvur'
                : 'Başvuruyu incelemeye gönder',
            busy: _busy,
            onPressed: ready ? _submit : null,
          ),
        ],
      ],
    );
  }
}

const _needsAttention = {
  'PROVIDER_PENDING',
  'SCHEDULED',
  'PROVIDER_ARRIVING',
  'CHECKED_IN',
  'IN_PROGRESS',
};

class _Upcoming extends ConsumerWidget {
  const _Upcoming();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(providerBookingsProvider).value ?? const <Booking>[];
    final next = list.where((b) => _needsAttention.contains(b.status)).toList()
      ..sort((a, b) => a.scheduledStart.compareTo(b.scheduledStart));
    if (next.isEmpty) return const SizedBox.shrink();
    return SectionCard(
      title: 'Sıradaki işler',
      children: [
        for (final booking in next.take(5))
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(
              formatRange(booking.scheduledStart, booking.scheduledEnd),
            ),
            subtitle: Align(
              alignment: Alignment.centerLeft,
              child: StatusBadge(providerBookingStatusView(booking.status)),
            ),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => context.push('/panel/randevular/${booking.id}'),
          ),
      ],
    );
  }
}
