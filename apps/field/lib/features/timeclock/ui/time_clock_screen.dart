import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../app/widgets/notifications_bell.dart';
import '../../../app/widgets/shell_drawer_button.dart';
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
      notifier.loadAdjustments();
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
      appBar: AppBar(
        leading: const ShellDrawerButton(),
        title: const Text('Minha jornada'),
        actions: const [NotificationsBell()],
      ),
      body: state.loading && state.workday.date.isEmpty
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: () async {
                // Puxar para atualizar traz o dia, o histórico e os
                // pedidos: recarregar só um deixaria a tela meio velha
                // sem dizer qual metade.
                await notifier.load();
                await notifier.loadHistory();
                await notifier.loadAdjustments();
              },
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
                  _AdjustmentsCard(state: state, notifier: notifier),
                  const SizedBox(height: AlfaSpacing.lg),
                  // previousDays, e não history: o dia de hoje já está no
                  // cartão do topo, e a rota devolve os dois.
                  _HistoryCard(history: state.previousDays),
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
              '${hhmmInCompanyTime(last.occurredAt, workday.utcOffset)}',
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
                    : Icon(timeEntryIcon(action)),
                label: Text(timeEntryAction(action)),
              ),
            ),
            const SizedBox(height: AlfaSpacing.sm),
          ],
          /*
            PORTA ÚNICA DA CORREÇÃO (PRD §258).

            Este cartão teve o seu próprio botão SOLICITAR CORREÇÃO, e a seção
            Correções tem outro. O piloto físico mostrou o custo: dois botões
            idênticos na mesma rolagem, um deles condicionado a um estado que o
            técnico não enxerga, e nenhuma pista de que levam ao mesmo lugar.
            Duas portas para a mesma sala é a pessoa perguntando qual é a certa.

            Ficou a da seção Correções, porque é onde o pedido VIVE depois de
            aberto: quem solicita volta ali para ver o desfecho. O caminho
            continua sem gesto e sem menu — está na mesma tela, uma rolagem
            abaixo.

            Este cartão passa a responder só quatro coisas: em que estado a
            jornada está, quanto já foi trabalhado, qual foi a última marcação
            e se existe correção esperando decisão.
          */
          if (workday.allowedActions.isEmpty)
            Text(
              'Jornada encerrada. Para corrigir, use Correções, logo abaixo.',
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          if (workday.pendingAdjustments > 0) ...[
            const SizedBox(height: AlfaSpacing.sm),
            Text(
              '${workday.pendingAdjustments} correção(ões) aguardando decisão.',
              style: const TextStyle(fontSize: 12),
            ),
          ],
          /*
            O que o SERVIDOR diz que não fecha neste dia (JOR-A2).

            A tela apresenta a lista; não a deduz de `state`. Estar em jornada
            agora é normal e não vem sinalizado — o que chega aqui é um dia que
            já virou com marcação incompleta, e aí a única saída é a correção.

            SEM botão: a porta única continua sendo a da seção Correções
            (§258). O texto aponta para lá em vez de abrir um segundo caminho.
          */
          if (workday.inconsistencies.isNotEmpty) ...[
            const SizedBox(height: AlfaSpacing.md),
            _InconsistencyBanner(messages: workday.inconsistencies),
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
      /*
        Retorno tátil na batida, e só nela.

        O ponto é registrado com o aparelho já saindo da mão, muitas vezes sem
        o técnico olhar a tela até o fim. A vibração confirma que o comando
        saiu sem exigir leitura — e é a diferença entre um aplicativo que
        "responde" e um que parece página web embrulhada.

        `mediumImpact`, não `heavy`: bater ponto é ação padrão do dia, não
        destrutiva. Vibração forte demais, quatro vezes por dia, cansa.
      */
      unawaited(HapticFeedback.mediumImpact());
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
                    leading: Icon(timeEntryIcon(entry.type), size: 18),
                    title: Text(timeEntryLabel(entry.type)),
                    subtitle: entry.fromAdjustment
                        // A correção aprovada é visível, não silenciosa: quem
                        // lê o espelho precisa saber o que foi batido e o que
                        // foi corrigido (§229).
                        ? const Text('Correção aprovada')
                        : null,
                    trailing: Text(
                      hhmmInCompanyTime(entry.occurredAt, workday.utcOffset),
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
          // 'anteriores' é literal: o dia corrente é o cartão do topo.
          ? const Text('Sem jornadas anteriores.')
          : Column(
              children: [
                for (final day in history.take(30))
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    title: Text(day.date),
                    /*
                      O dia passado em aberto mostra o que NÃO fecha, junto do
                      estado.

                      O total ao lado é só o tempo confirmado — o período sem
                      fim provado não entra nele (JOR-A1). Sem esta linha, o
                      técnico veria um dia com menos horas do que trabalhou e
                      nenhuma pista do porquê.
                    */
                    subtitle: Text(
                      day.inconsistencies.isEmpty
                          ? workdayStateLabel(day.state)
                          : '${workdayStateLabel(day.state)} · '
                                '${day.inconsistencies.join(' ')}',
                    ),
                    trailing: Text(minutesLabel(day.workedMinutes)),
                  ),
              ],
            ),
    );
  }
}

/// As correções: a porta de entrada e o desfecho de cada pedido.
///
/// Seção própria porque o pedido tem VIDA: ele é aberto, espera e é decidido.
/// Sem esta lista, quem pediu não sabia se o gestor tinha visto, aprovado ou
/// recusado — e a recusa, que é justamente a que precisa de contraditório,
/// desaparecia em silêncio (PRD §229).
class _AdjustmentsCard extends StatelessWidget {
  const _AdjustmentsCard({required this.state, required this.notifier});

  final TimeClockState state;
  final TimeClockController notifier;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SectionCard(
      title: 'Correções',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              key: const Key('request-adjustment'),
              onPressed: () => openAdjustmentSheet(context, state, notifier),
              icon: const Icon(Icons.edit_calendar_outlined),
              label: const Text('SOLICITAR CORREÇÃO'),
            ),
          ),
          const SizedBox(height: AlfaSpacing.md),
          if (state.adjustments.isEmpty)
            Text(
              'Nenhuma correção solicitada.',
              style: theme.textTheme.bodyMedium,
            )
          else
            for (final pedido in state.adjustments.take(10))
              Padding(
                padding: const EdgeInsets.only(bottom: AlfaSpacing.sm),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      // O deslocamento é o do dia de HOJE. A lista mostra
                      // pedidos de outros dias, e num fuso com horário de
                      // verão um deles pode aparecer com uma hora de
                      // diferença — a data vai ao lado, e nada aqui é
                      // gravado. O horário que o servidor guarda continua
                      // sendo o montado na folha, com o deslocamento certo.
                      '${timeEntryLabel(pedido.requestedEntryType)} às '
                      '${hhmmInCompanyTime(pedido.requestedOccurredAt, state.workday.utcOffset)}'
                      ' · ${pedido.workdayDate}',
                      style: const TextStyle(fontWeight: FontWeight.w600),
                    ),
                    Text(
                      adjustmentStatusLabel(pedido.status),
                      key: Key('adjustment-status-${pedido.id}'),
                      style: theme.textTheme.bodySmall,
                    ),
                    /*
                      O horário pedido NÃO é aplicado na jornada enquanto o
                      pedido espera. A lista mostra o que foi PEDIDO; o cartão
                      de cima continua mostrando o que VALE — e os dois só
                      passam a coincidir depois da aprovação.
                    */
                    if (pedido.decisionReason != null &&
                        pedido.decisionReason!.isNotEmpty)
                      Text(
                        pedido.decisionReason!,
                        style: theme.textTheme.bodySmall,
                      ),
                  ],
                ),
              ),
        ],
      ),
    );
  }
}

/// Abre o formulário de correção.
///
/// Folha modal, e não tela nova: o técnico está olhando a jornada e precisa
/// continuar olhando enquanto descreve o que houve nela.
Future<void> openAdjustmentSheet(
  BuildContext context,
  TimeClockState state,
  TimeClockController notifier,
) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (_) => Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom,
      ),
      child: _AdjustmentSheet(workday: state.workday, notifier: notifier),
    ),
  );
}

class _AdjustmentSheet extends StatefulWidget {
  const _AdjustmentSheet({required this.workday, required this.notifier});

  final Workday workday;
  final TimeClockController notifier;

  @override
  State<_AdjustmentSheet> createState() => _AdjustmentSheetState();
}

class _AdjustmentSheetState extends State<_AdjustmentSheet> {
  String? _targetEntryId;
  TimeEntryType _type = TimeEntryType.clockIn;
  TimeOfDay? _hora;
  final _reason = TextEditingController();

  bool _enviando = false;
  String? _erro;

  @override
  void initState() {
    super.initState();
    // Com marcação no dia, a primeira é o palpite mais provável de correção.
    // Sem nenhuma, o caso é inclusão do que faltou — e o alvo fica nulo.
    final primeira = widget.workday.entries.isEmpty
        ? null
        : widget.workday.entries.first;
    if (primeira != null) {
      _targetEntryId = primeira.id;
      _type = primeira.type;
      // No relógio da EMPRESA, como o campo será relido ao enviar. Preencher
      // com a hora do aparelho e enviar no fuso da empresa faria o formulário
      // deslocar sozinho uma marcação que ninguém quis mudar.
      _hora = TimeOfDay.fromDateTime(
        inCompanyTime(primeira.occurredAt, widget.workday.utcOffset),
      );
    }
  }

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  void _selecionarAlvo(String? id) {
    setState(() {
      _targetEntryId = id;
      final alvo = widget.workday.entries.where((e) => e.id == id).firstOrNull;
      if (alvo != null) {
        _type = alvo.type;
        _hora = TimeOfDay.fromDateTime(
          inCompanyTime(alvo.occurredAt, widget.workday.utcOffset),
        );
      }
    });
  }

  /// O instante pedido, no DIA e no FUSO que o servidor informou.
  ///
  /// A data vem do workday, nunca de `DateTime.now()`: perto da meia-noite os
  /// dois discordam, e ancorar no relógio do aparelho mandaria a correção para
  /// o dia seguinte.
  ///
  /// O FUSO vem do workday pelo mesmo motivo, um degrau acima. `08:30` é
  /// 08:30 na empresa — o aparelho pode estar em qualquer fuso, e antes disto
  /// era ele quem definia o instante enviado (§253, LOW-3).
  DateTime? _instante() {
    final hora = _hora;
    if (hora == null) return null;
    return instantFromCompanyTime(
      widget.workday.date,
      hora.hour,
      hora.minute,
      widget.workday.utcOffset,
    );
  }

  Future<void> _enviar() async {
    if (_enviando) return;

    final instante = _instante();
    if (instante == null) {
      setState(() => _erro = 'Informe o horário correto.');
      return;
    }
    if (_reason.text.trim().isEmpty) {
      setState(() => _erro = 'Descreva o que aconteceu.');
      return;
    }
    if (instante.isAfter(DateTime.now())) {
      // O servidor também recusa. Recusar aqui poupa a ida e dá a razão certa.
      setState(() => _erro = 'O horário não pode estar no futuro.');
      return;
    }

    setState(() {
      _enviando = true;
      _erro = null;
    });

    final falha = await widget.notifier.requestAdjustment(
      entryType: _type,
      occurredAt: instante,
      reason: _reason.text,
      targetEntryId: _targetEntryId,
    );

    if (!mounted) return;
    if (falha == null) {
      Navigator.of(context).pop();
      return;
    }
    /*
      A recusa do servidor FICA na folha.

      Fechar aqui diria 'enviado' para um pedido que não existe — e o técnico
      só descobriria ao não ver a correção na lista, ou pior, ao não vê-la
      aplicada no fim do mês.
    */
    setState(() {
      _enviando = false;
      _erro = falha;
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final entries = widget.workday.entries;

    return Padding(
      padding: const EdgeInsets.all(AlfaSpacing.lg),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Solicitar correção', style: theme.textTheme.titleLarge),
            const SizedBox(height: AlfaSpacing.xs),
            Text(
              'Você não altera a marcação. O pedido vai para aprovação, e o '
              'registro original continua no histórico.',
              style: theme.textTheme.bodySmall,
            ),
            const SizedBox(height: AlfaSpacing.lg),
            DropdownButtonFormField<String?>(
              key: const Key('adjustment-target'),
              initialValue: _targetEntryId,
              decoration: const InputDecoration(labelText: 'Marcação'),
              items: [
                const DropdownMenuItem<String?>(
                  value: null,
                  child: Text('Marcação que faltou'),
                ),
                for (final entry in entries)
                  DropdownMenuItem<String?>(
                    value: entry.id,
                    child: Text(
                      '${timeEntryLabel(entry.type)} às '
                      '${hhmmInCompanyTime(entry.occurredAt, widget.workday.utcOffset)}',
                    ),
                  ),
              ],
              onChanged: _enviando ? null : _selecionarAlvo,
            ),
            const SizedBox(height: AlfaSpacing.lg),
            DropdownButtonFormField<TimeEntryType>(
              key: const Key('adjustment-type'),
              initialValue: _type,
              decoration: const InputDecoration(labelText: 'Deveria ser'),
              items: [
                for (final tipo in const [
                  TimeEntryType.clockIn,
                  TimeEntryType.breakStart,
                  TimeEntryType.breakEnd,
                  TimeEntryType.clockOut,
                ])
                  DropdownMenuItem(
                    value: tipo,
                    child: Text(timeEntryLabel(tipo)),
                  ),
              ],
              onChanged: _enviando
                  ? null
                  : (valor) => setState(() => _type = valor ?? _type),
            ),
            const SizedBox(height: AlfaSpacing.lg),
            InputDecorator(
              decoration: const InputDecoration(labelText: 'Horário correto'),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      _hora == null
                          ? 'Escolher horário'
                          : '${_hora!.hour.toString().padLeft(2, '0')}:'
                                '${_hora!.minute.toString().padLeft(2, '0')}',
                    ),
                  ),
                  TextButton(
                    key: const Key('adjustment-pick-time'),
                    onPressed: _enviando
                        ? null
                        : () async {
                            final escolhido = await showTimePicker(
                              context: context,
                              initialTime: _hora ?? TimeOfDay.now(),
                            );
                            if (escolhido != null) {
                              setState(() => _hora = escolhido);
                            }
                          },
                    child: const Text('ALTERAR'),
                  ),
                ],
              ),
            ),
            const SizedBox(height: AlfaSpacing.lg),
            TextField(
              key: const Key('adjustment-reason'),
              controller: _reason,
              enabled: !_enviando,
              maxLength: 500,
              decoration: const InputDecoration(
                labelText: 'Motivo',
                hintText: 'O que aconteceu',
              ),
            ),
            if (_erro != null) ...[
              const SizedBox(height: AlfaSpacing.sm),
              Text(
                _erro!,
                key: const Key('adjustment-error'),
                style: TextStyle(color: context.statusColors.danger),
              ),
            ],
            const SizedBox(height: AlfaSpacing.lg),
            FilledButton(
              key: const Key('adjustment-submit'),
              onPressed: _enviando ? null : _enviar,
              child: _enviando
                  ? const SizedBox(
                      height: 20,
                      width: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('ENVIAR PEDIDO'),
            ),
          ],
        ),
      ),
    );
  }
}

/// O que não fecha no dia, como o servidor o descreve.
///
/// Aviso, não erro: nada falhou, e a pessoa não fez nada de errado que a tela
/// possa afirmar. A cor é a de atenção, e o ícone acompanha o texto — cor
/// sozinha não é sinal (PRD §149).
///
/// **Não tem botão.** A porta única da correção é a seção `Correções` (§258),
/// e um CTA aqui seria a segunda porta que o piloto físico já mostrou custar
/// caro.
class _InconsistencyBanner extends StatelessWidget {
  const _InconsistencyBanner({required this.messages});

  final List<String> messages;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      key: const Key('workday-inconsistencies'),
      padding: const EdgeInsets.all(AlfaSpacing.md),
      decoration: BoxDecoration(
        color: scheme.tertiaryContainer,
        borderRadius: BorderRadius.circular(AlfaRadius.md),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            Icons.warning_amber_outlined,
            color: scheme.onTertiaryContainer,
            size: 20,
          ),
          const SizedBox(width: AlfaSpacing.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // O texto vem do servidor e é apresentado como TEXTO.
                for (final message in messages)
                  Text(
                    message,
                    style: TextStyle(
                      color: scheme.onTertiaryContainer,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                const SizedBox(height: AlfaSpacing.xs),
                Text(
                  'Existe uma marcação incompleta neste dia. '
                  'Solicite uma correção se necessário.',
                  style: TextStyle(
                    color: scheme.onTertiaryContainer,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
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
