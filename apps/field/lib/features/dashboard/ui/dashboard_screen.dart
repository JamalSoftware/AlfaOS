import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/providers.dart';
import '../../../app/theme/tokens.dart';
import '../../../app/widgets/notifications_bell.dart';
import '../../../app/widgets/shell_drawer_button.dart';
import '../../../core/widgets/state_views.dart';
import '../../orders/domain/service_order.dart';
import '../../orders/state/orders_controller.dart';
import '../../orders/ui/order_card.dart';
import '../../timeclock/domain/workday.dart';
import '../../timeclock/state/time_clock_controller.dart';

/// INÍCIO — "o que eu faço agora" (PRD §257).
///
/// Primeira tela do App Shell, e a mais barata de errar: é a única que o
/// técnico vê em todo dia de trabalho, mesmo no dia em que ele não abre OS
/// nenhuma nem bate um intervalo — o mesmo raciocínio que já tirou a Jornada
/// do "app de OS" (§226) agora se aplica ao aplicativo inteiro (§254).
///
/// ## O Dashboard não decide nada
///
/// Cada card lê um estado que já existe em algum outro lugar do app —
/// `timeClockControllerProvider`, `ordersControllerProvider` — e não duplica
/// controlador, repositório nem cálculo. A jornada mostra `allowedActions`
/// como o servidor mandou; as ordens mostram o que a lista real já carregou.
/// Um Dashboard que recalculasse por conta própria divergiria do resto do
/// aplicativo na primeira correção aprovada ou na primeira OS reatribuída.
///
/// ## Um card com erro não derruba o outro
///
/// Jornada e OS carregam de fontes diferentes, e uma pane na fila de OS não
/// pode apagar o card de jornada que já respondeu — cada bloco trata o
/// próprio erro.
class DashboardScreen extends ConsumerStatefulWidget {
  const DashboardScreen({super.key});

  @override
  ConsumerState<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends ConsumerState<DashboardScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadAll());
  }

  void _loadAll() {
    ref.read(timeClockControllerProvider.notifier).load();
    ref.read(ordersControllerProvider.notifier).load();
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionControllerProvider).session;

    return Scaffold(
      appBar: AppBar(
        leading: const ShellDrawerButton(),
        title: const Text('AlfaOS Field'),
        actions: const [NotificationsBell()],
      ),
      body: RefreshIndicator(
        onRefresh: () async => _loadAll(),
        child: ListView(
          padding: const EdgeInsets.all(AlfaSpacing.lg),
          children: [
            _Greeting(name: session?.firstName ?? ''),
            const SizedBox(height: AlfaSpacing.lg),
            const _JornadaCard(),
            const SizedBox(height: AlfaSpacing.lg),
            const _OrdersCard(),
          ],
        ),
      ),
    );
  }
}

/// Saudação por período do dia.
///
/// Puramente cosmético: lê o relógio do APARELHO só para escolher a palavra
/// "Bom dia" / "Boa tarde" / "Boa noite", e não decide nada além disso. Nenhum
/// dado de jornada, prazo ou fato operacional depende deste horário — essa
/// autoridade continua sendo só do servidor (§227, §253/LOW-3).
class _Greeting extends StatelessWidget {
  const _Greeting({required this.name});

  final String name;

  static String _periodo() {
    final hora = DateTime.now().hour;
    if (hora < 12) return 'Bom dia';
    if (hora < 18) return 'Boa tarde';
    return 'Boa noite';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final saudacao = name.isEmpty ? _periodo() : '${_periodo()},';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(saudacao, style: theme.textTheme.headlineSmall),
        if (name.isNotEmpty)
          Text(
            name,
            style: theme.textTheme.headlineSmall?.copyWith(
              fontWeight: FontWeight.w700,
            ),
          ),
      ],
    );
  }
}

/// Card JORNADA: estado, tempo trabalhado, última marcação, uma ação.
///
/// ## A ação abre a Jornada — não bate ponto por conta própria
///
/// Tocar o botão leva à tela `/jornada`, onde a marcação de fato acontece com
/// a confirmação que já existe lá (§229 — marcação é imutável, um toque
/// acidental não pode virar batida sem aviso). Duplicar aquele diálogo aqui
/// criaria um segundo lugar para a mesma proteção divergir; o Dashboard aponta
/// o caminho, a tela de Jornada é onde ele se completa.
class _JornadaCard extends ConsumerWidget {
  const _JornadaCard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(timeClockControllerProvider);
    final theme = Theme.of(context);

    if (state.loading && state.workday.date.isEmpty) {
      return const SectionCard(
        title: 'Jornada',
        child: SizedBox(
          height: 48,
          child: Center(
            child: SizedBox(
              height: 20,
              width: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          ),
        ),
      );
    }

    if (state.error != null && state.workday.date.isEmpty) {
      return SectionCard(
        title: 'Jornada',
        child: ErrorView(
          message: 'Não foi possível carregar a jornada.',
          onRetry: () => ref.read(timeClockControllerProvider.notifier).load(),
        ),
      );
    }

    final workday = state.workday;
    final last = workday.lastEntry;
    final proximaAcao = workday.allowedActions.isEmpty
        ? null
        : workday.allowedActions.first;

    return SectionCard(
      title: 'Jornada',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Text(
                workdayStateLabel(workday.state),
                style: theme.textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w700,
                ),
              ),
              const Spacer(),
              Text(
                'Trabalhado: ${minutesLabel(workday.workedMinutes)}',
                style: theme.textTheme.bodyMedium,
              ),
            ],
          ),
          if (last != null) ...[
            const SizedBox(height: AlfaSpacing.sm),
            Row(
              children: [
                Icon(
                  timeEntryIcon(last.type),
                  size: 16,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
                const SizedBox(width: AlfaSpacing.xs),
                Text(
                  '${timeEntryLabel(last.type)} às '
                  '${hhmmInCompanyTime(last.occurredAt, workday.utcOffset)}',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ],
          const SizedBox(height: AlfaSpacing.md),
          if (proximaAcao != null)
            OutlinedButton(
              key: const Key('dashboard-jornada-action'),
              onPressed: () => context.go('/jornada'),
              child: Text(timeEntryAction(proximaAcao)),
            )
          else
            Text(
              'Jornada encerrada.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
        ],
      ),
    );
  }
}

/// Card ORDENS DE SERVIÇO: contagens reais, e a próxima OS quando existe
/// critério para dizer qual é.
class _OrdersCard extends ConsumerWidget {
  const _OrdersCard();

  /// A OS mais próxima, entre as ainda ABERTAS, pelo horário que o SERVIDOR
  /// agendou.
  ///
  /// Não é heurística inventada no cliente: `scheduledAt` é campo real do
  /// contrato (`docs/FIELD-API.md`), e escolher o menor entre as não
  /// concluídas é o mesmo critério que "o que vem primeiro na minha agenda".
  /// Quando NENHUMA ordem carregada tem horário, não existe critério — e o
  /// card não inventa um, mostrando o link para a lista em vez de um palpite.
  static OrderSummary? _proxima(List<OrderSummary> items) {
    OrderSummary? achou;
    for (final order in items) {
      if (order.status == OrderStatus.completed ||
          order.status == OrderStatus.cancelled) {
        continue;
      }
      final quando = order.scheduledAt;
      if (quando == null) continue;
      if (achou == null || quando.isBefore(achou.scheduledAt!)) {
        achou = order;
      }
    }
    return achou;
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(ordersControllerProvider);
    final theme = Theme.of(context);

    if (state.loading && state.items.isEmpty) {
      return const SectionCard(
        title: 'Ordens de Serviço',
        child: SizedBox(
          height: 48,
          child: Center(
            child: SizedBox(
              height: 20,
              width: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          ),
        ),
      );
    }

    if (state.error != null && state.items.isEmpty) {
      return SectionCard(
        title: 'Ordens de Serviço',
        child: ErrorView(
          message: 'Não foi possível carregar suas ordens.',
          onRetry: () => ref.read(ordersControllerProvider.notifier).load(),
        ),
      );
    }

    final total = state.items.length;
    final emAndamento = state.items
        .where((o) => o.status == OrderStatus.inProgress)
        .length;
    final pendentes = state.items
        .where(
          (o) =>
              o.status == OrderStatus.pending ||
              o.status == OrderStatus.assigned,
        )
        .length;
    final proxima = _proxima(state.items);

    return SectionCard(
      title: 'Ordens de Serviço',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              _Contador(label: 'Total', value: total),
              _Contador(label: 'Em andamento', value: emAndamento),
              _Contador(label: 'Pendentes', value: pendentes),
            ],
          ),
          const SizedBox(height: AlfaSpacing.md),
          if (proxima != null) ...[
            Text(
              'PRÓXIMA OS',
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
                letterSpacing: 0.8,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: AlfaSpacing.sm),
            OrderCard(
              order: proxima,
              onTap: () => context.push('/orders/${proxima.id}'),
            ),
          ] else
            OutlinedButton(
              key: const Key('dashboard-orders-see-all'),
              onPressed: () => context.go('/orders'),
              child: const Text('VER MINHAS OS'),
            ),
        ],
      ),
    );
  }
}

class _Contador extends StatelessWidget {
  const _Contador({required this.label, required this.value});

  final String label;
  final int value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Expanded(
      child: Column(
        children: [
          Text(
            '$value',
            style: theme.textTheme.headlineSmall?.copyWith(
              fontWeight: FontWeight.w700,
            ),
          ),
          Text(
            label,
            textAlign: TextAlign.center,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}
