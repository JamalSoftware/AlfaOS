import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/widgets/state_views.dart';
import '../domain/workday.dart';
import '../state/time_clock_controller.dart';

/// # MINHA JORNADA
///
/// Uma tela, uma decisão: qual a próxima marcação. Tudo o mais é consulta.
///
/// **O botão vem do servidor.** `allowedActions` decide o que aparece; a tela
/// não deriva transição nenhuma (PRD §229). É o que garante que um APK antigo
/// em campo não ofereça uma ação que o servidor já não aceita.
class TimeClockScreen extends ConsumerStatefulWidget {
  const TimeClockScreen({super.key});

  @override
  ConsumerState<TimeClockScreen> createState() => _TimeClockScreenState();
}

class _TimeClockScreenState extends ConsumerState<TimeClockScreen> {
  @override
  void initState() {
    super.initState();
    Future.microtask(() {
      final notifier = ref.read(timeClockControllerProvider.notifier);
      notifier.load();
      notifier.loadHistory();
    });
  }

  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(timeClockControllerProvider);
    final notifier = ref.read(timeClockControllerProvider.notifier);

    ref.listen(timeClockControllerProvider, (previous, next) {
      if (next.message != null && next.message != previous?.message) {
        _toast(next.message!);
        notifier.consumeMessage();
      }
    });

    return Scaffold(
      appBar: AppBar(title: const Text('Minha jornada')),
      body: state.loading && state.workday.date.isEmpty
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: notifier.load,
              child: ListView(
                padding: const EdgeInsets.all(AlfaSpacing.lg),
                children: [
                  if (state.error != null) ...[
                    _ErrorBanner(
                      message: state.error!,
                      onDismiss: notifier.consumeError,
                    ),
                    const SizedBox(height: AlfaSpacing.lg),
                  ],
                  _TodayCard(state: state, notifier: notifier),
                  const SizedBox(height: AlfaSpacing.lg),
                  _EntriesCard(workday: state.workday),
                  const SizedBox(height: AlfaSpacing.lg),
                  _HistoryCard(history: state.history),
                ],
              ),
            ),
    );
  }
}

class _TodayCard extends StatelessWidget {
  const _TodayCard({required this.state, required this.notifier});

  final TimeClockState state;
  final TimeClockController notifier;

  @override
  Widget build(BuildContext context) {
    final workday = state.workday;
    final last = workday.lastEntry;

    return SectionCard(
      title: 'Jornada de hoje',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              _WorkdayPill(state: workday.state),
              const Spacer(),
              Text(
                'Trabalhado: ${minutesLabel(workday.workedMinutes)}',
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ],
          ),
          if (workday.breakMinutes > 0) ...[
            const SizedBox(height: AlfaSpacing.sm),
            Text(
              'Intervalo: ${minutesLabel(workday.breakMinutes)}',
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ],
          if (last != null) ...[
            const SizedBox(height: AlfaSpacing.md),
            Text(
              'Última marcação: ${timeEntryLabel(last.type)} às '
              '${_hhmm(last.occurredAt)}',
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
          ],
          const SizedBox(height: AlfaSpacing.lg),
          /*
            Um botão por ação PERMITIDA PELO SERVIDOR.

            Lista vazia significa jornada encerrada — e não há botão nenhum,
            porque reabrir não é batida, é correção (§229).
          */
          for (final action in workday.allowedActions) ...[
            SizedBox(
              width: double.infinity,
              height: AlfaSizing.primaryActionHeight,
              child: FilledButton.icon(
                key: Key('punch-${timeEntryTypeWire(action)}'),
                onPressed: state.busy
                    ? null
                    : () => _confirmAndPunch(context, notifier, action),
                icon: state.busy
                    ? const SizedBox(
                        height: 20,
                        width: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Icon(_iconFor(action)),
                label: Text(timeEntryAction(action)),
              ),
            ),
            const SizedBox(height: AlfaSpacing.sm),
          ],
          if (workday.allowedActions.isEmpty)
            Text(
              'Jornada encerrada. Para corrigir, solicite um ajuste.',
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          if (workday.pendingAdjustments > 0) ...[
            const SizedBox(height: AlfaSpacing.sm),
            Text(
              '${workday.pendingAdjustments} correção(ões) aguardando decisão.',
              style: const TextStyle(fontSize: 12),
            ),
          ],
        ],
      ),
    );
  }

  /// Confirma antes de gravar.
  ///
  /// A marcação é imutável: um toque acidental em "encerrar jornada" só se
  /// desfaz por pedido de correção com aprovação. Um diálogo é barato perto
  /// disso.
  Future<void> _confirmAndPunch(
    BuildContext context,
    TimeClockController notifier,
    TimeEntryType action,
  ) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('${timeEntryLabel(action)}?'),
        content: const Text(
          'O horário é registrado pelo servidor e não pode ser editado depois. '
          'Correções passam por aprovação.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancelar'),
          ),
          FilledButton(
            key: const Key('punch-confirm'),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Confirmar'),
          ),
        ],
      ),
    );
    if (confirmed ?? false) {
      await notifier.punch(action);
    }
  }
}

class _EntriesCard extends StatelessWidget {
  const _EntriesCard({required this.workday});

  final Workday workday;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      title: 'Marcações de hoje',
      child: workday.entries.isEmpty
          ? const Text('Nenhuma marcação hoje.')
          : Column(
              children: [
                for (final entry in workday.entries)
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(_iconFor(entry.type), size: 18),
                    title: Text(timeEntryLabel(entry.type)),
                    subtitle: entry.fromAdjustment
                        // A correção aprovada é visível, não silenciosa: quem
                        // lê o espelho precisa saber o que foi batido e o que
                        // foi corrigido (§229).
                        ? const Text('Correção aprovada')
                        : null,
                    trailing: Text(
                      _hhmm(entry.occurredAt),
                      style: const TextStyle(fontWeight: FontWeight.w600),
                    ),
                  ),
              ],
            ),
    );
  }
}

class _HistoryCard extends StatelessWidget {
  const _HistoryCard({required this.history});

  final List<WorkdaySummary> history;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      title: 'Histórico',
      child: history.isEmpty
          ? const Text('Sem jornadas anteriores.')
          : Column(
              children: [
                for (final day in history.take(30))
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    title: Text(day.date),
                    subtitle: Text(workdayStateLabel(day.state)),
                    trailing: Text(minutesLabel(day.workedMinutes)),
                  ),
              ],
            ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.message, required this.onDismiss});

  final String message;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(AlfaSpacing.md),
      decoration: BoxDecoration(
        color: scheme.errorContainer,
        borderRadius: BorderRadius.circular(AlfaRadius.md),
      ),
      child: Row(
        children: [
          Icon(Icons.error_outline, color: scheme.onErrorContainer, size: 20),
          const SizedBox(width: AlfaSpacing.sm),
          Expanded(
            child: Text(
              message,
              style: TextStyle(color: scheme.onErrorContainer),
            ),
          ),
          IconButton(
            icon: const Icon(Icons.close),
            onPressed: onDismiss,
            tooltip: 'Dispensar',
          ),
        ],
      ),
    );
  }
}

String _hhmm(DateTime value) =>
    '${value.hour.toString().padLeft(2, '0')}:'
    '${value.minute.toString().padLeft(2, '0')}';

IconData _iconFor(TimeEntryType type) {
  switch (type) {
    case TimeEntryType.clockIn:
      return Icons.login;
    case TimeEntryType.breakStart:
      return Icons.free_breakfast_outlined;
    case TimeEntryType.breakEnd:
      return Icons.work_outline;
    case TimeEntryType.clockOut:
      return Icons.logout;
    case TimeEntryType.unknown:
      return Icons.schedule;
  }
}

/// Estado da jornada com ponto e rótulo.
///
/// Pílula própria, e não a `StatusPill`: aquela é presa a `OrderStatus`, e
/// forçá-la a servir dois domínios acabaria com um enum que mistura "OS
/// concluída" com "jornada encerrada". A regra do design system é a mesma —
/// **cor nunca é o único sinal**, então o rótulo sempre acompanha.
class _WorkdayPill extends StatelessWidget {
  const _WorkdayPill({required this.state});

  final WorkdayState state;

  @override
  Widget build(BuildContext context) {
    final colors = context.statusColors;
    final (fg, bg) = switch (state) {
      WorkdayState.working => (colors.success, colors.successContainer),
      WorkdayState.onBreak => (colors.warning, colors.warningContainer),
      WorkdayState.finished => (colors.info, colors.infoContainer),
      WorkdayState.notStarted => (colors.neutral, colors.neutralContainer),
      WorkdayState.unknown => (colors.neutral, colors.neutralContainer),
    };

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AlfaSpacing.md,
        vertical: AlfaSpacing.xs,
      ),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(AlfaRadius.pill),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.circle, size: 8, color: fg),
          const SizedBox(width: AlfaSpacing.sm),
          Text(
            workdayStateLabel(state),
            style: TextStyle(
              color: fg,
              fontWeight: FontWeight.w600,
              fontSize: 12,
            ),
          ),
        ],
      ),
    );
  }
}
