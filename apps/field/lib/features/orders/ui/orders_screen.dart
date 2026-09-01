import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/providers.dart';
import '../../../app/theme/tokens.dart';
import '../../../app/widgets/notifications_bell.dart';
import '../../../app/widgets/shell_drawer_button.dart';
import '../../../core/widgets/local_order_note.dart';
import '../../../core/widgets/position_badge.dart';
import '../../../core/widgets/state_views.dart';
import '../domain/service_order.dart';
import '../domain/dispatch_queue.dart';
import '../state/dispatch_queue_controller.dart';
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
      ref.read(dispatchQueueControllerProvider.notifier).load();
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
        onRefresh: () => Future.wait([
          ref.read(ordersControllerProvider.notifier).load(refresh: true),
          ref.read(dispatchQueueControllerProvider.notifier).load(),
        ]),
        child: _body(state),
      ),
    );
  }

  Widget _body(OrdersState state) {
    /*
      A FILA AUTORITATIVA manda quando existe (DQ-6).

      A lista paginada de `/service-orders` continua carregada porque ela é o
      modo de compatibilidade — servidor anterior à DQ-5, sem a rota da fila.
      Os dois caminhos NUNCA se misturam: ou a tela obedece ao despacho, ou
      declara que está no modo antigo. Um híbrido seria a segunda autoridade
      que esta fase existe para eliminar.
    */
    final queue = ref.watch(dispatchQueueControllerProvider);
    if (queue.queue != null) return _authoritative(queue.queue!);

    if (queue.loading && !queue.loaded) {
      return const Center(child: CircularProgressIndicator());
    }

    /*
      Erro da fila, sem nada a mostrar: a tela não ordena por conta própria.

      Mas quando as DUAS fontes falham a causa é uma só — rede, sessão,
      servidor fora —, e a mensagem também precisa ser uma só. Falar de "fila"
      para quem está sem conexão nenhuma descreve o sintoma menor.
    */
    final ordensFalharam = state.error != null && state.items.isEmpty;
    if (queue.error != null && !queue.unavailable && !ordensFalharam) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          SizedBox(height: MediaQuery.sizeOf(context).height * 0.18),
          ErrorView(
            message: 'Não foi possível atualizar sua fila.',
            onRetry: () =>
                ref.read(dispatchQueueControllerProvider.notifier).load(),
          ),
        ],
      );
    }

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
        /*
          Daqui para baixo, a ordem é do APLICATIVO.

          O aviso é a fronteira visível entre os dois modos: sem ele, a lista
          local teria a mesma aparência da fila do despachante, e a diferença
          existiria só no código. Marcar procedência é o que torna o fallback
          honesto em vez de silencioso.
        */
        if (queue.unavailable) const LocalOrderNote(),
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

  /// A tela com a fila autoritativa: EM ATENDIMENTO + PRÓXIMAS NA FILA.
  ///
  /// A ordem é a que chegou. **Nada é reordenado aqui** — nem por número, nem
  /// por prioridade, nem por horário. O despachante decidiu, e a posição
  /// aparece ao lado de cada card para que a decisão dele seja legível.
  Widget _authoritative(DispatchQueue queue) {
    if (queue.isEmpty) {
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

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(AlfaSpacing.lg),
      children: [
        if (queue.inProgress.isNotEmpty) ...[
          const _GroupLabel('Em atendimento'),
          // Coleção: mais de uma em atendimento é permitido, e esconder as
          // demais apagaria trabalho que existe.
          ...queue.inProgress.map(_card),
          const SizedBox(height: AlfaSpacing.lg),
        ],
        if (queue.queued.isNotEmpty) ...[
          const _GroupLabel('Próximas na fila'),
          for (final item in queue.queued)
            Padding(
              padding: const EdgeInsets.only(bottom: AlfaSpacing.md),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.only(top: AlfaSpacing.md),
                    child: PositionBadge(position: item.position),
                  ),
                  const SizedBox(width: AlfaSpacing.sm),
                  Expanded(
                    child: OrderCard(
                      order: item.order,
                      onTap: () => context.push('/orders/${item.order.id}'),
                    ),
                  ),
                ],
              ),
            ),
        ],
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
