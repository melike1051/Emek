import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'features/auth/login_screen.dart';
import 'features/auth/role_select_screen.dart';
import 'features/customer/booking_screens.dart';
import 'features/customer/explore_screen.dart';
import 'features/customer/request_screens.dart';
import 'features/home/customer_shell.dart';
import 'features/home/provider_shell.dart';
import 'features/provider/profile_screens.dart';
import 'features/provider/provider_bookings.dart';
import 'features/provider/provider_home.dart';
import 'features/safety/safety_screen.dart';
import 'session/providers.dart';
import 'session/session.dart';

/// Oturum durumuna göre hedef rota; `null` → istenen yerde kal. Saf fonksiyon (test edilir).
///
/// - Oturum yok → `/giris` (başka yere gidilmez).
/// - Oturum kuruluyor/hatalı → `/giris` ekranı durumu gösterir.
/// - Profil yok → `/rol-sec`.
/// - `/panel` sağlayıcı profili ister.
String? sessionRedirect({
  required bool? signedIn,
  required AsyncValue<Session?> session,
  required String location,
}) {
  final atLogin = location == '/giris';
  if (signedIn != true) return atLogin ? null : '/giris';
  final current = session.value;
  if (current == null) return atLogin ? null : '/giris';
  if (!current.hasProfile) return location == '/rol-sec' ? null : '/rol-sec';
  if (atLogin) return current.home;
  if (location.startsWith('/panel') && current.provider == null) return '/';
  return null;
}

/// Riverpod durumunu go_router'ın `refreshListenable`'ına bağlar.
class _RouterRefresh extends ChangeNotifier {
  _RouterRefresh(Ref ref) {
    ref.listen(signedInProvider, (_, _) => notifyListeners());
    ref.listen(sessionProvider, (_, _) => notifyListeners());
  }
}

final _rootKey = GlobalKey<NavigatorState>();

final routerProvider = Provider<GoRouter>((ref) {
  final refresh = _RouterRefresh(ref);
  ref.onDispose(refresh.dispose);
  return GoRouter(
    navigatorKey: _rootKey,
    initialLocation: '/',
    refreshListenable: refresh,
    redirect: (context, state) => sessionRedirect(
      signedIn: ref.read(signedInProvider).value,
      session: ref.read(sessionProvider),
      location: state.matchedLocation,
    ),
    routes: [
      GoRoute(path: '/giris', builder: (_, _) => const LoginScreen()),
      GoRoute(path: '/rol-sec', builder: (_, _) => const RoleSelectScreen()),
      ShellRoute(
        builder: (_, state, child) =>
            CustomerShell(location: state.matchedLocation, child: child),
        routes: [
          GoRoute(
            path: '/',
            builder: (_, _) => const ExploreScreen(),
            routes: [
              // Ayrıntı ekranları kabuğun üstünde (kök navigator) açılır; geri gezinme URL
              // hiyerarşisini izler (eşleşme → talep → keşfet).
              GoRoute(
                path: 'talep/:id',
                parentNavigatorKey: _rootKey,
                builder: (_, state) =>
                    RequestReviewScreen(requestId: state.pathParameters['id']!),
                routes: [
                  GoRoute(
                    path: 'eslesme',
                    parentNavigatorKey: _rootKey,
                    builder: (_, state) => MatchResultScreen(
                      requestId: state.pathParameters['id']!,
                    ),
                  ),
                ],
              ),
            ],
          ),
          GoRoute(
            path: '/randevular',
            builder: (_, _) => const BookingsScreen(),
            routes: [
              GoRoute(
                path: ':id',
                parentNavigatorKey: _rootKey,
                builder: (_, state) =>
                    BookingDetailScreen(bookingId: state.pathParameters['id']!),
                routes: [
                  GoRoute(
                    path: 'guvenlik',
                    parentNavigatorKey: _rootKey,
                    builder: (_, state) =>
                        SafetyScreen(bookingId: state.pathParameters['id']!),
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
      ShellRoute(
        builder: (_, state, child) =>
            ProviderShell(location: state.matchedLocation, child: child),
        routes: [
          GoRoute(
            path: '/panel',
            builder: (_, _) => const ProviderHomeScreen(),
            routes: [
              GoRoute(
                path: 'profil',
                parentNavigatorKey: _rootKey,
                builder: (_, _) => const ProviderProfileScreen(),
              ),
              GoRoute(
                path: 'hizmetler',
                parentNavigatorKey: _rootKey,
                builder: (_, _) => const ProviderServicesScreen(),
              ),
              GoRoute(
                path: 'bolgeler',
                parentNavigatorKey: _rootKey,
                builder: (_, _) => const ServiceAreasScreen(),
              ),
              GoRoute(
                path: 'musaitlik',
                parentNavigatorKey: _rootKey,
                builder: (_, _) => const AvailabilityScreen(),
              ),
              GoRoute(
                path: 'randevular',
                builder: (_, _) => const ProviderBookingsScreen(),
                routes: [
                  GoRoute(
                    path: ':id',
                    parentNavigatorKey: _rootKey,
                    builder: (_, state) => ProviderBookingDetailScreen(
                      bookingId: state.pathParameters['id']!,
                    ),
                    routes: [
                      GoRoute(
                        path: 'oturum',
                        parentNavigatorKey: _rootKey,
                        builder: (_, state) => SafetyScreen(
                          bookingId: state.pathParameters['id']!,
                          perspective: SafetyPerspective.provider,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  );
});
