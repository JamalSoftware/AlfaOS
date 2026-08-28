import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../features/notifications/state/notifications_controller.dart';

/// Casca do aplicativo: três destinos e nada mais.
///
/// Três, e não oito. O técnico abre o app para ver o trabalho de agora; cada
/// aba a mais é uma decisão a mais entre ele e a próxima OS. Evidências,
/// materiais e ferramentas entram quando existirem, e provavelmente **dentro**
/// da OS, não como aba própria.
class HomeShell extends ConsumerWidget {
  const HomeShell({super.key, required this.navigationShell});

  final StatefulNavigationShell navigationShell;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final unread = ref.watch(
      notificationsControllerProvider.select((s) => s.unreadCount),
    );

    return Scaffold(
      body: navigationShell,
      bottomNavigationBar: NavigationBar(
        selectedIndex: navigationShell.currentIndex,
        onDestinationSelected: (index) => navigationShell.goBranch(
          index,
          // Tocar na aba já ativa volta ao topo dela, em vez de não fazer nada.
          initialLocation: index == navigationShell.currentIndex,
        ),
        destinations: [
          const NavigationDestination(
            icon: Icon(Icons.assignment_outlined),
            selectedIcon: Icon(Icons.assignment),
            label: 'OS',
          ),
          NavigationDestination(
            icon: Badge(
              // Contador simples, alimentado pela própria listagem. Sem
              // sincronização em background: gastar bateria e dados do técnico
              // por um número seria um mau negócio antes de o push existir.
              isLabelVisible: unread > 0,
              label: Text('$unread'),
              child: const Icon(Icons.notifications_outlined),
            ),
            selectedIcon: const Icon(Icons.notifications),
            label: 'Notificações',
          ),
          const NavigationDestination(
            icon: Icon(Icons.more_horiz_outlined),
            selectedIcon: Icon(Icons.more_horiz),
            label: 'Mais',
          ),
        ],
      ),
    );
  }
}
