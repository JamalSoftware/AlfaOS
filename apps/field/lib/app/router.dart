import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../features/auth/state/session_controller.dart';
import '../features/auth/ui/login_screen.dart';
import '../features/notifications/ui/notifications_screen.dart';
import '../features/orders/ui/order_detail_screen.dart';
import '../features/orders/ui/orders_screen.dart';
import '../features/settings/ui/settings_screen.dart';
import 'home_shell.dart';
import 'providers.dart';

final _rootKey = GlobalKey<NavigatorState>();
final _shellKey = GlobalKey<NavigatorState>();

/// Navegação declarativa, com a sessão como guarda.
///
/// O `redirect` é o **único** lugar que decide se alguém entra: tela nenhuma
/// verifica sessão por conta própria, e por isso nenhuma pode esquecer. Quando
/// a sessão cai — 401, revogação, logout — o estado muda e a navegação
/// acompanha sozinha, sem cada tela precisar reagir.
final routerProvider = Provider<GoRouter>((ref) {
  final phase = ref.watch(sessionControllerProvider.select((s) => s.phase));

  return GoRouter(
    navigatorKey: _rootKey,
    initialLocation: '/orders',
    refreshListenable: _PhaseListenable(ref),
    redirect: (context, state) {
      final location = state.matchedLocation;

      switch (phase) {
        case SessionPhase.bootstrapping:
          return location == '/splash' ? null : '/splash';
        case SessionPhase.revoked:
          return location == '/revoked' ? null : '/revoked';
        case SessionPhase.offline:
          return location == '/offline' ? null : '/offline';
        case SessionPhase.unauthenticated:
          return location == '/login' ? null : '/login';
        case SessionPhase.authenticated:
          // Já autenticado não fica preso nas telas de porta.
          const gates = {'/login', '/splash', '/revoked', '/offline'};
          return gates.contains(location) ? '/orders' : null;
      }
    },
    routes: [
      GoRoute(path: '/splash', builder: (_, _) => const BootstrapScreen()),
      GoRoute(path: '/login', builder: (_, _) => const LoginScreen()),
      GoRoute(path: '/revoked', builder: (_, _) => const RevokedScreen()),
      GoRoute(
        path: '/offline',
        builder: (_, _) => const OfflineBootstrapScreen(),
      ),
      GoRoute(
        // Detalhe fora do shell: em campo ele ocupa a tela inteira, e a barra
        // de abas embaixo só disputaria espaço com a ação principal.
        parentNavigatorKey: _rootKey,
        path: '/orders/:id',
        builder: (_, state) =>
            OrderDetailScreen(orderId: state.pathParameters['id']!),
      ),
      StatefulShellRoute.indexedStack(
        builder: (_, _, shell) => HomeShell(navigationShell: shell),
        branches: [
          StatefulShellBranch(
            navigatorKey: _shellKey,
            routes: [
              GoRoute(path: '/orders', builder: (_, _) => const OrdersScreen()),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/notifications',
                builder: (_, _) => const NotificationsScreen(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/settings',
                builder: (_, _) => const SettingsScreen(),
              ),
            ],
          ),
        ],
      ),
    ],
  );
});

/// Reavalia o `redirect` quando a fase da sessão muda.
class _PhaseListenable extends ChangeNotifier {
  _PhaseListenable(Ref ref) {
    _sub = ref.listen<SessionPhase>(
      sessionControllerProvider.select((s) => s.phase),
      (_, _) => notifyListeners(),
    );
  }

  late final ProviderSubscription<SessionPhase> _sub;

  @override
  void dispose() {
    _sub.close();
    super.dispose();
  }
}
