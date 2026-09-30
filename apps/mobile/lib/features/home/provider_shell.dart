import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../push/push_registrar.dart';
import '../../session/providers.dart';

/// Sağlayıcı çalışma alanı kabuğu: alt gezinme (Panel / Randevular). Müşteri profili de varsa
/// müşteri görünümüne geçiş sunulur.
class ProviderShell extends ConsumerWidget {
  const ProviderShell({super.key, required this.location, required this.child});
  final String location;
  final Widget child;

  static const _tabs = [
    ('/panel', 'Panel', Icons.dashboard_outlined),
    ('/panel/randevular', 'Randevular', Icons.event_available_outlined),
  ];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider).value;
    final index = location.startsWith('/panel/randevular') ? 1 : 0;
    return Scaffold(
      appBar: AppBar(
        title: Text(_tabs[index].$2),
        actions: [
          if (session?.customer != null)
            TextButton(
              onPressed: () => context.go('/'),
              child: const Text('Müşteri'),
            ),
          IconButton(
            tooltip: 'Çıkış yap',
            icon: const Icon(Icons.logout),
            onPressed: () => ref.read(pushRegistrarProvider.notifier).signOut(),
          ),
        ],
      ),
      body: child,
      bottomNavigationBar: NavigationBar(
        selectedIndex: index,
        onDestinationSelected: (i) => context.go(_tabs[i].$1),
        destinations: [
          for (final (_, label, icon) in _tabs)
            NavigationDestination(icon: Icon(icon), label: label),
        ],
      ),
    );
  }
}
