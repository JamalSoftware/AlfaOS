import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/providers.dart';
import '../../../app/theme/tokens.dart';
import '../../../app/widgets/notifications_bell.dart';
import '../../../app/widgets/shell_drawer_button.dart';
import '../../../core/widgets/state_views.dart';
import '../domain/service_order.dart';
import '../state/orders_controller.dart';
import 'order_card.dart';

/// "Minhas Ordens" — a tela que abre quando o técnico entra.
///
/// A fila é do portador do token, e só dele: não existe filtro de técnico nem
/// parâmetro que troque o dono. O agrupamento visual entre "em atendimento" e
/// "atribuídas" é apresentação; **não** altera posse nem estado.
class OrdersScreen extends ConsumerStatefulWidget {
  const OrdersScreen({super.key});

  @override
  ConsumerState<OrdersScreen> createState() => _OrdersScreenState();
}

class _OrdersScreenState extends ConsumerState<OrdersScreen> {
  final _scrollController = ScrollController();

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(_onScroll);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(ordersControllerProvider.notifier).load();
    });
  }

  @override
  void dispose() {
    _scrollController.removeListener(_onScroll);
    _scrollController.dispose();
    super.dispose();
  }

  /// Carrega a próxima página perto do fim.
  ///
  /// O controlador tem as guardas contra reentrada e contra cursor repetido —
  /// aqui só se decide QUANDO pedir, não se pode pedir.
  void _onScroll() {
    if (!_scrollController.hasClients) return;
    final position = _scrollController.position;
    if (position.pixels >= position.maxScrollExtent - 240) {
      ref.read(ordersControllerProvider.notifier).loadMore();
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(ordersControllerProvider);
    final session = ref.watch(sessionControllerProvider).session;
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        leading: const ShellDrawerButton(),
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Minhas Ordens'),
            if (session != null)
              Text(
                session.firstName,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
          ],
        ),
        actions: const [NotificationsBell()],
      ),
      body: RefreshIndicator(
        onRefresh: () =>
            ref.read(ordersControllerProvider.notifier).load(refresh: true),
        child: _body(state),
      ),
    );
  }

  Widget _body(OrdersState state) {
    if (state.loading && state.items.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }

    if (state.error != null && state.items.isEmpty) {
      return ListView(
        // Precisa rolar para o pull-to-refresh funcionar mesmo vazio.
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          SizedBox(height: MediaQuery.sizeOf(context).height * 0.18),
          ErrorView(
            message: 'Não foi possível carregar suas ordens.',
            onRetry: () => ref.read(ordersControllerProvider.notifier).load(),
          ),
        ],
      );
    }

    if (state.isEmpty) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          SizedBox(height: MediaQuery.sizeOf(context).height * 0.18),
          const EmptyView(
            title: 'Nenhuma ordem atribuída no momento.',
            description: 'Puxe para atualizar quando receber uma nova.',
            icon: Icons.assignment_outlined,
          ),
        ],
      );
    }

    final inProgress = state.inProgress;
    final assigned = state.assigned;

    return ListView(
      controller: _scrollController,
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(AlfaSpacing.lg),
      children: [
        if (inProgress.isNotEmpty) ...[
          const _GroupLabel('Em atendimento'),
          ...inProgress.map(_card),
          const SizedBox(height: AlfaSpacing.lg),
        ],
        if (assigned.isNotEmpty) ...[
          if (inProgress.isNotEmpty) const _GroupLabel('Atribuídas'),
          ...assigned.map(_card),
        ],
        if (state.loadingMore)
          const Padding(
            padding: EdgeInsets.all(AlfaSpacing.lg),
            child: Center(child: CircularProgressIndicator()),
          ),
      ],
    );
  }

  Widget _card(OrderSummary order) => Padding(
    padding: const EdgeInsets.only(bottom: AlfaSpacing.md),
    child: OrderCard(
      order: order,
      onTap: () => context.push('/orders/${order.id}'),
    ),
  );
}

class _GroupLabel extends StatelessWidget {
  const _GroupLabel(this.label);

  final String label;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: AlfaSpacing.sm),
      child: Text(
        label.toUpperCase(),
        style: theme.textTheme.labelSmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
          letterSpacing: 0.8,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}
