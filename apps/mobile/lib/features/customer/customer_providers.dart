import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/customer_api.dart';
import '../../session/providers.dart';

final customerApiProvider = Provider<CustomerApi>(
  (ref) => CustomerApi(ref.watch(apiClientProvider)),
);

/// Katalog referans verisidir; oturum boyunca bir kez okunur (web: 1 saat taze).
final categoriesProvider = FutureProvider<List<ServiceCategory>>(
  (ref) => ref.watch(customerApiProvider).categories(),
);
final servicesProvider = FutureProvider<List<ServiceDefinition>>(
  (ref) => ref.watch(customerApiProvider).services(),
);

final addressesProvider = FutureProvider.autoDispose<List<Address>>(
  (ref) => ref.watch(customerApiProvider).addresses(),
);

final requestProvider = FutureProvider.autoDispose
    .family<BookingRequest, String>(
      (ref, id) => ref.watch(customerApiProvider).request(id),
    );
final matchResultProvider = FutureProvider.autoDispose
    .family<MatchResult, String>(
      (ref, id) => ref.watch(customerApiProvider).matchResult(id),
    );

final bookingsProvider = FutureProvider.autoDispose<List<Booking>>(
  (ref) => ref.watch(customerApiProvider).bookings(),
);
final bookingProvider = FutureProvider.autoDispose.family<Booking, String>(
  (ref, id) => ref.watch(customerApiProvider).booking(id),
);
final historyProvider = FutureProvider.autoDispose
    .family<List<BookingHistoryEntry>, String>(
      (ref, id) => ref.watch(customerApiProvider).history(id),
    );
final paymentProvider = FutureProvider.autoDispose.family<Payment?, String>(
  (ref, id) => ref.watch(customerApiProvider).payment(id),
);
final disputesProvider = FutureProvider.autoDispose
    .family<List<Dispute>, String>(
      (ref, id) => ref.watch(customerApiProvider).disputes(id),
    );
final safetySessionProvider = FutureProvider.autoDispose
    .family<SafetySession?, String>(
      (ref, bookingId) =>
          ref.watch(customerApiProvider).safetySession(bookingId),
    );

/// Bir randevu komutundan sonra ilgili tüm görünümler tazelenir (web: `['bookings']` invalidate).
void invalidateBooking(WidgetRef ref, String bookingId) {
  ref
    ..invalidate(bookingProvider(bookingId))
    ..invalidate(historyProvider(bookingId))
    ..invalidate(paymentProvider(bookingId))
    ..invalidate(disputesProvider(bookingId))
    ..invalidate(bookingsProvider);
}
