import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/providers.dart';
import '../../../app/theme/tokens.dart';
import '../../../app/widgets/notifications_bell.dart';
import '../../../app/widgets/shell_drawer_button.dart';
import '../../../core/widgets/state_views.dart';
import '../../../core/widgets/status_pill.dart';
import '../../orders/domain/service_order.dart';
import '../../orders/state/orders_controller.dart';
import '../../timeclock/domain/workday.dart';
import '../../timeclock/state/time_clock_controller.dart';
import '../domain/attention_ranking.dart';

/// INÍCIO — "o que eu faço agora" (PRD §257).
///
/// Primeira tela do App Shell, e a mais barata de errar: é a única que o
/// técnico vê em todo dia de trabalho, mesmo no dia em que ele não abre OS
/// nenhuma nem bate um intervalo — o mesmo raciocínio que já tirou a Jornada
/// do "app de OS" (§226) agora se aplica ao aplicativo inteiro (§254).
///
/// ## O Dashboard não decide nada
///
/// Cada bloco lê um estado que já existe em algum outro lugar do app —
/// `timeClockControllerProvider`, `ordersControllerProvider` — e não duplica
/// controlador, repositório nem cálculo. A jornada mostra `allowedActions`
/// como o servidor mandou; as ordens mostram o que a lista real já carregou.
/// Um Dashboard que recalculasse por conta própria divergiria do resto do
/// aplicativo na primeira correção aprovada ou na primeira OS reatribuída.
///
/// ## Um bloco com erro não derruba o outro
///
/// Jornada e OS carregam de fontes diferentes, e uma pane na fila de OS não
/// pode apagar o card de jornada que já respondeu — cada bloco trata o
/// próprio erro, e o Hero se degrada em vez de sumir.
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
          children: const [
            _HeroCard(),
            SizedBox(height: AlfaSpacing.lg),
            _AttentionSection(),
            SizedBox(height: AlfaSpacing.lg),
            _JornadaCard(),
            SizedBox(height: AlfaSpacing.lg),
            _OrdersCard(),
          ],
        ),
      ),
    );
  }
}

/// O HERO: saudação, identidade e o resumo do dia numa linha.
///
/// ## Ele se degrada, não quebra
///
/// Cada linha do resumo depende de uma fonte diferente, e cada uma some
/// sozinha quando o dado não existe — carregando, com erro, ou simplesmente
/// vazio. O bloco de saudação e empresa **sempre** aparece, porque vem da
/// sessão, que já está resolvida quando esta tela existe. Uma falha na fila de
/// OS não pode apagar o nome do técnico do topo da tela.
///
/// ## Nada é recalculado aqui
///
/// `workedMinutes` vem do servidor (§230); o estado da jornada vem de
/// `allowedActions`/`state` (§229); as contagens de OS saem da lista real. O
/// Hero **formata**, não computa.
class _HeroCard extends ConsumerWidget {
  const _HeroCard();

  static String _periodo() {
    final hora = DateTime.now().hour;
    if (hora < 12) return 'Bom dia';
    if (hora < 18) return 'Boa tarde';
    return 'Boa noite';
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final colors = context.statusColors;

    final session = ref.watch(sessionControllerProvider).session;
    final clock = ref.watch(timeClockControllerProvider);
    final orders = ref.watch(ordersControllerProvider);

    final nome = session?.firstName ?? '';
    final saudacao = nome.isEmpty ? _periodo() : '${_periodo()}, $nome';

    // A jornada só entra na linha de resumo quando o servidor já respondeu.
    final workday = clock.workday;
    final temJornada = workday.date.isNotEmpty;

    final abertas = orders.items.where(
      (o) =>
          o.status != OrderStatus.completed &&
          o.status != OrderStatus.cancelled,
    );
    final urgentes = abertas
        .where((o) => o.priority == OrderPriority.urgent)
        .length;

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(AlfaSpacing.xl),
      decoration: BoxDecoration(
        color: scheme.primaryContainer,
        borderRadius: BorderRadius.circular(AlfaRadius.lg),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            saudacao,
            style: theme.textTheme.headlineSmall?.copyWith(
              color: scheme.onPrimaryContainer,
              fontWeight: FontWeight.w700,
            ),
          ),
          if (session != null && session.companyName.isNotEmpty) ...[
            const SizedBox(height: 2),
            Text(
              session.companyName,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: scheme.onPrimaryContainer.withValues(alpha: 0.8),
              ),
            ),
          ],
          if (temJornada || orders.loaded) ...[
            const SizedBox(height: AlfaSpacing.lg),
            Wrap(
              spacing: AlfaSpacing.sm,
              runSpacing: AlfaSpacing.sm,
              children: [
                if (temJornada)
                  _HeroChip(
                    // Ponto E rótulo: cor sozinha não é sinal.
                    icon: Icons.circle,
                    iconColor: switch (workday.state) {
                      WorkdayState.working => colors.success,
                      WorkdayState.onBreak => colors.warning,
                      WorkdayState.finished => colors.neutral,
                      _ => colors.neutral,
                    },
                    label: workday.state == WorkdayState.notStarted
                        ? workdayStateLabel(workday.state)
                        : '${workdayStateLabel(workday.state)} · '
                              '${minutesLabel(workday.workedMinutes)}',
                  ),
                if (orders.loaded)
                  _HeroChip(
                    icon: Icons.assignment_outlined,
                    label: abertas.length == 1
                        ? '1 OS aberta'
                        : '${abertas.length} OS abertas',
                  ),
                if (urgentes > 0)
                  _HeroChip(
                    icon: Icons.priority_high,
                    iconColor: colors.danger,
                    label: urgentes == 1 ? '1 urgente' : '$urgentes urgentes',
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _HeroChip extends StatelessWidget {
  const _HeroChip({required this.icon, required this.label, this.iconColor});

  final IconData icon;
  final String label;
  final Color? iconColor;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AlfaSpacing.md,
        vertical: AlfaSpacing.sm,
      ),
      decoration: BoxDecoration(
        color: scheme.surface.withValues(alpha: 0.65),
        borderRadius: BorderRadius.circular(AlfaRadius.pill),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 12, color: iconColor ?? scheme.onSurfaceVariant),
          const SizedBox(width: AlfaSpacing.sm),
          // `Flexible` + elipse: um rótulo longo ("TRABALHANDO · 12h 30min")
          // numa tela de 360dp estourava a linha em 24px. Encolher é melhor
          // que a faixa listrada — e o dado inteiro continua no card abaixo.
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall?.copyWith(
                color: scheme.onSurface,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// ATENÇÃO AGORA — as OS que pedem ação, agendadas ou não.
///
/// O bloco que faltava: uma OS atribuída **sem `scheduledAt`** — o caso da
/// importada do ReceitaNet — não era "próxima" de ninguém e sumia do Início.
/// A regra de ordenação vive em `attentionOrders`, testada à parte de
/// qualquer widget.
class _AttentionSection extends ConsumerWidget {
  const _AttentionSection();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(ordersControllerProvider);
    final theme = Theme.of(context);

    // Sem dado ainda, ou falhou: o card de OS abaixo já reporta o erro. Este
    // bloco simplesmente não aparece, em vez de repetir a mesma mensagem.
    if (!state.loaded || state.items.isEmpty) return const SizedBox.shrink();

    final destaques = attentionOrders(state.items);
    if (destaques.isEmpty) return const SizedBox.shrink();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.only(
            left: AlfaSpacing.xs,
            bottom: AlfaSpacing.sm,
          ),
          child: Text(
            'ATENÇÃO AGORA',
            style: theme.textTheme.labelSmall?.copyWith(
              color: theme.colorScheme.primary,
              letterSpacing: 0.8,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
        for (final order in destaques) ...[
          _AttentionCard(order: order),
          const SizedBox(height: AlfaSpacing.sm),
        ],
        Align(
          alignment: Alignment.centerRight,
          child: TextButton(
            key: const Key('dashboard-see-all-orders'),
            onPressed: () => context.go('/orders'),
            child: const Text('VER TODAS AS OS'),
          ),
        ),
      ],
    );
  }
}

/// Card operacional de uma OS em destaque.
///
/// **Não mostra origem de provedor.** O DTO do Field deliberadamente não traz
/// `origin`, `externalProvider` nem `externalNumber` — uma OS importada chega
/// idêntica a uma interna, e é essa ausência que impede um `if (RECEITANET)`
/// no aplicativo (`src/lib/field/dto.ts`, PRD §254). Deduzir a origem do texto
/// do tipo seria inventar um dado que o servidor decidiu não enviar.
class _AttentionCard extends StatelessWidget {
  const _AttentionCard({required this.order});

  final OrderSummary order;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = context.statusColors;
    final emAtendimento = order.status == OrderStatus.inProgress;
    final urgente = order.priority == OrderPriority.urgent;

    // A borda destaca; o rótulo explica. Quem não distingue a cor lê o
    // `StatusPill` e o `PriorityBadge`, que são texto.
    final borda = emAtendimento
        ? colors.info
        : urgente
        ? colors.danger
        : theme.colorScheme.outlineVariant;

    return Material(
      color: theme.colorScheme.surfaceContainerLow,
      borderRadius: BorderRadius.circular(AlfaRadius.lg),
      child: InkWell(
        key: Key('attention-order-${order.id}'),
        onTap: () => context.push('/orders/${order.id}'),
        borderRadius: BorderRadius.circular(AlfaRadius.lg),
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(AlfaRadius.lg),
            border: Border.all(
              color: borda,
              width: emAtendimento || urgente ? 1.5 : 1,
            ),
          ),
          padding: const EdgeInsets.all(AlfaSpacing.lg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              /*
                `Wrap`, e não `Row`: numa tela de 360dp o trio "OS Nº 1234" +
                selo de prioridade + pílula de status não cabia numa linha, e
                o `Spacer` empurrava a pílula para fora. Quebrando a linha, o
                status desce em vez de ser cortado — e continua legível, que é
                o que importa num card lido de relance.
              */
              Wrap(
                spacing: AlfaSpacing.sm,
                runSpacing: AlfaSpacing.xs,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Text(
                    'OS Nº ${order.number}',
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  PriorityBadge(priority: order.priority),
                  StatusPill(status: order.status, compact: true),
                ],
              ),
              const SizedBox(height: AlfaSpacing.sm),
              Text(
                order.customerName,
                style: theme.textTheme.bodyLarge?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              const SizedBox(height: AlfaSpacing.xs),
              Text(
                order.subtype == null || order.subtype!.isEmpty
                    ? order.type
                    : '${order.type} · ${order.subtype}',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
        ),
      ),
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
    final colors = context.statusColors;

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

    final (estadoFg, estadoBg) = switch (workday.state) {
      WorkdayState.working => (colors.success, colors.successContainer),
      WorkdayState.onBreak => (colors.warning, colors.warningContainer),
      WorkdayState.finished => (colors.info, colors.infoContainer),
      _ => (colors.neutral, colors.neutralContainer),
    };

    return SectionCard(
      title: 'Jornada',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: AlfaSpacing.md,
                  vertical: AlfaSpacing.xs,
                ),
                decoration: BoxDecoration(
                  color: estadoBg,
                  borderRadius: BorderRadius.circular(AlfaRadius.pill),
                ),
                child: Text(
                  workdayStateLabel(workday.state),
                  style: theme.textTheme.labelSmall?.copyWith(color: estadoFg),
                ),
              ),
              const Spacer(),
              // Jornada longa ("12h 45min") ao lado de "TRABALHANDO" não cabe
              // em 360dp; o total encolhe antes de a linha estourar.
              Flexible(
                child: Text(
                  minutesLabel(workday.workedMinutes),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.titleLarge?.copyWith(
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ],
          ),
          if (last != null) ...[
            const SizedBox(height: AlfaSpacing.md),
            Row(
              children: [
                Icon(
                  timeEntryIcon(last.type),
                  size: 16,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
                const SizedBox(width: AlfaSpacing.xs),
                // "Retorno do intervalo às 08:02" é o rótulo mais longo dos
                // quatro e estourava a linha numa tela de 360dp.
                Expanded(
                  child: Text(
                    '${timeEntryLabel(last.type)} às '
                    '${hhmmInCompanyTime(last.occurredAt, workday.utcOffset)}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
              ],
            ),
          ],
          const SizedBox(height: AlfaSpacing.lg),
          if (proximaAcao != null)
            FilledButton.tonal(
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
  /// card não inventa um. **Isso continua verdade mesmo com o bloco "Atenção
  /// agora"**: aquele bloco mostra o que pede ação, sem chamar nada de
  /// "próxima"; os dois respondem perguntas diferentes.
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
              _Contador(
                label: 'Em atendimento',
                value: emAndamento,
                highlight: emAndamento > 0,
              ),
              _Contador(label: 'Pendentes', value: pendentes),
            ],
          ),
          if (proxima != null) ...[
            const SizedBox(height: AlfaSpacing.lg),
            Text(
              'PRÓXIMA OS',
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
                letterSpacing: 0.8,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: AlfaSpacing.sm),
            _AttentionCard(order: proxima),
          ],
        ],
      ),
    );
  }
}

class _Contador extends StatelessWidget {
  const _Contador({
    required this.label,
    required this.value,
    this.highlight = false,
  });

  final String label;
  final int value;
  final bool highlight;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = context.statusColors;
    return Expanded(
      child: Column(
        children: [
          Text(
            '$value',
            style: theme.textTheme.headlineMedium?.copyWith(
              fontWeight: FontWeight.w700,
              color: highlight ? colors.info : theme.colorScheme.onSurface,
            ),
          ),
          const SizedBox(height: 2),
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
