import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/customer_api.dart';
import '../../api/provider_api.dart';
import '../../domain/provider_rules.dart';
import '../../session/providers.dart';
import '../customer/customer_providers.dart';

final providerApiProvider = Provider<ProviderApi>(
  (ref) => ProviderApi(ref.watch(apiClientProvider)),
);

final skillCatalogProvider = FutureProvider<List<SkillDefinition>>(
  (ref) => ref.watch(providerApiProvider).skillCatalog(),
);
final mySkillsProvider = FutureProvider.autoDispose<List<ProviderSkill>>(
  (ref) => ref.watch(providerApiProvider).skills(),
);
final myServicesProvider = FutureProvider.autoDispose<List<ProviderService>>(
  (ref) => ref.watch(providerApiProvider).services(),
);
final myAreasProvider = FutureProvider.autoDispose<List<ServiceArea>>(
  (ref) => ref.watch(providerApiProvider).areas(),
);
final identityVerifiedProvider = FutureProvider.autoDispose<bool>(
  (ref) => ref.watch(providerApiProvider).identityVerified(),
);

/// Önümüzdeki 30 günün müsaitliği — hazırlık listesi için (web `useProviderQueries`).
final upcomingAvailabilityProvider =
    FutureProvider.autoDispose<List<AvailabilityWindow>>((ref) {
      final now = DateTime.now().toUtc();
      return ref
          .watch(providerApiProvider)
          .availability(now, now.add(const Duration(days: 30)));
    });

/// Bir haftanın müsaitliği; anahtar haftanın pazartesisi (İstanbul günü).
final weekAvailabilityProvider = FutureProvider.autoDispose
    .family<List<AvailabilityWindow>, DateTime>((ref, monday) {
      final from = istanbulAt(monday, 0, 0);
      return ref
          .watch(providerApiProvider)
          .availability(from, from.add(const Duration(days: 7)));
    });

/// Sağlayıcı olarak verilen randevular (aynı hesap müşteri de olabilir).
final providerBookingsProvider = FutureProvider.autoDispose<List<Booking>>((
  ref,
) async {
  final userId = ref.watch(sessionProvider).value?.userId;
  final all = await ref.watch(bookingsProvider.future);
  return all.where((b) => b.providerId == userId).toList();
});

/// Hizmet adresi (R-102). Her okuma backend'de audit kaydıdır: ekran açıkken tekrar istenmez,
/// yalnız ekrandan çıkınca (autoDispose) bırakılır.
final bookingAddressProvider = FutureProvider.autoDispose
    .family<BookingAddress, String>(
      (ref, bookingId) => ref.watch(providerApiProvider).address(bookingId),
    );

final documentsProvider = FutureProvider.autoDispose
    .family<List<EvidenceDocument>, String>(
      (ref, bookingId) => ref.watch(providerApiProvider).documents(bookingId),
    );

/// Profil hazırlığını etkileyen her değişiklikten sonra (web: `PROVIDER_KEYS.all`).
void invalidateReadiness(WidgetRef ref) {
  ref
    ..invalidate(myServicesProvider)
    ..invalidate(myAreasProvider)
    ..invalidate(upcomingAvailabilityProvider)
    ..invalidate(mySkillsProvider);
}
