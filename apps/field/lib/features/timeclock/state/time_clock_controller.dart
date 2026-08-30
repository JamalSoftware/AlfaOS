import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/providers.dart';
import '../../../core/api/idempotency.dart';
import '../../../core/errors/field_error.dart';
import '../../../core/location/location_service.dart';
import '../data/time_clock_repository.dart';
import '../domain/workday.dart';

@immutable
class TimeClockState {
  const TimeClockState({
    this.workday = Workday.empty,
    this.history = const [],
    this.adjustments = const [],
    this.loading = true,
    this.busy = false,
    this.error,
    this.message,
    this.lastPunch,
    this.syncStatus = PunchSyncStatus.synced,
  });

  final Workday workday;

  /// O que o SERVIDOR devolveu em `/history` — inclusive o dia de hoje.
  ///
  /// Guardado cru de propósito. Quem quer a lista da seção "Histórico" usa
  /// [previousDays]: filtrar na origem esconderia do próximo leitor que a rota
  /// devolve hoje também, e a mesma confusão voltaria.
  final List<WorkdaySummary> history;

  /// Os pedidos de correção do próprio técnico, com o desfecho de cada um.
  final List<TimeAdjustment> adjustments;

  final bool loading;

  /// Um comando em voo. Trava o botão — a proteção real é a chave de
  /// idempotência, mas piscar o botão evita a corrida antes de ela existir.
  final bool busy;

  final String? error;
  final String? message;

  /// A marcação que acabou de ser registrada, para a confirmação na tela.
  final TimeEntry? lastPunch;

  /// Hoje sempre `synced` quando há marcação: não existe fila offline (§232).
  /// O campo existe para a tela não precisar ser redesenhada quando existir.
  final PunchSyncStatus syncStatus;

  /// O histórico SEM o dia corrente.
  ///
  /// `GET /time-clock/history` vai até hoje, e é o certo: é a mesma rota que
  /// serve um recorte de datas qualquer, e recortá-la no servidor tiraria de
  /// quem consulta "de 1 a 31" o último dia do mês.
  ///
  /// Mas a tela já mostra hoje inteiro, com marcações e botões, no cartão de
  /// cima. Repetir a mesma data logo abaixo, como se fosse jornada passada,
  /// fazia o técnico ver o próprio dia duas vezes e duvidar de qual valia — foi
  /// o que o piloto em aparelho real encontrou.
  ///
  /// O corte usa a data que o SERVIDOR chamou de hoje (`workday.date`), nunca o
  /// relógio do aparelho: o dia operacional é o dia civil no fuso da EMPRESA, e
  /// um celular em outro fuso — ou com a data adiantada — cortaria o dia errado.
  List<WorkdaySummary> get previousDays {
    final hoje = workday.date;
    if (hoje.isEmpty) return history;
    return history.where((day) => day.date != hoje).toList(growable: false);
  }

  TimeClockState copyWith({
    Workday? workday,
    List<WorkdaySummary>? history,
    List<TimeAdjustment>? adjustments,
    bool? loading,
    bool? busy,
    String? error,
    String? message,
    TimeEntry? lastPunch,
    PunchSyncStatus? syncStatus,
    bool clearError = false,
    bool clearMessage = false,
  }) => TimeClockState(
    workday: workday ?? this.workday,
    history: history ?? this.history,
    adjustments: adjustments ?? this.adjustments,
    loading: loading ?? this.loading,
    busy: busy ?? this.busy,
    error: clearError ? null : (error ?? this.error),
    message: clearMessage ? null : (message ?? this.message),
    lastPunch: lastPunch ?? this.lastPunch,
    syncStatus: syncStatus ?? this.syncStatus,
  );
}

/// Estado da tela MINHA JORNADA.
///
/// ## Uma regra atravessa tudo
///
/// **O aplicativo não decide.** Ele não calcula horas, não deriva a próxima
/// transição e não carimba horário. Os três vêm do servidor (PRD §227, §229,
/// §230) — e é isso que garante que um APK velho em campo não ofereça uma ação
/// que o servidor já não aceita.
class TimeClockController extends StateNotifier<TimeClockState> {
  TimeClockController({
    required TimeClockRepository repository,
    required LocationService location,
  }) : _repository = repository,
       _location = location,
       super(const TimeClockState());

  final TimeClockRepository _repository;
  final LocationService _location;

  /// Chaves de intenção por tipo de marcação.
  ///
  /// Criada no TOQUE e guardada até a intenção se cumprir: reapresentar a MESMA
  /// chave é o que torna a retentativa segura (§232). Uma chave nova a cada
  /// envio faria o servidor ver comandos distintos, e uma reconexão instável
  /// produziria três entradas para a mesma pessoa.
  final Map<String, String> _intentKeys = {};

  String _intentKey(TimeEntryType type) =>
      _intentKeys[timeEntryTypeWire(type)] ??= IdempotencyKey.forOperation(
        'time-clock-${timeEntryTypeWire(type)}',
      );

  /// Chaves de intenção dos PEDIDOS DE CORREÇÃO, pela mesma regra das batidas.
  ///
  /// Antes a chave era criada dentro do envio, então cada tentativa era um
  /// comando novo aos olhos do servidor: um timeout seguido de "tentar de novo"
  /// abria DOIS pedidos idênticos, e o gestor recebia a mesma correção duas
  /// vezes na fila.
  ///
  /// A chave é indexada pelo CONTEÚDO do pedido. Reenviar o mesmo pedido
  /// reapresenta a mesma chave — que é o que torna a retentativa segura. Mudar
  /// qualquer campo depois de uma recusa produz outra assinatura e, portanto,
  /// outra chave: sem isso o segundo envio bateria em `IDEMPOTENCY_CONFLICT`
  /// por reusar a chave de um corpo diferente.
  final Map<String, String> _adjustmentKeys = {};

  String _adjustmentKey(String assinatura) => _adjustmentKeys[assinatura] ??=
      IdempotencyKey.forOperation('time-clock-adjustment');

  Future<void> load() async {
    state = state.copyWith(loading: true, clearError: true);
    try {
      final workday = await _repository.today();
      state = state.copyWith(
        workday: workday,
        loading: false,
        clearError: true,
      );
    } on FieldException catch (error) {
      state = state.copyWith(loading: false, error: error.message);
    }
  }

  Future<void> loadHistory() async {
    try {
      /*
        O `await` vem ANTES da leitura de `state`, e isso não é estilo.

        Em Dart, `state.copyWith(history: await ...)` avalia o RECEPTOR
        primeiro: `state` é lido antes da ida à rede, e o `copyWith` acaba
        aplicado sobre um estado velho — apagando o que o `load()` concorrente
        acabou de gravar. É o mesmo defeito que a tela de execução já teve.
      */
      final history = await _repository.history();
      state = state.copyWith(history: history);
    } on FieldException {
      // Histórico é consulta: falhar aqui não pode derrubar a batida de hoje.
    }
  }

  /// Os próprios pedidos de correção.
  ///
  /// Consulta, como o histórico: falhar aqui não pode derrubar a batida de hoje.
  Future<void> loadAdjustments() async {
    try {
      final adjustments = await _repository.adjustments();
      state = state.copyWith(adjustments: adjustments);
    } on FieldException {
      // Silencioso de propósito — ver `loadHistory`.
    }
  }

  /// Registra uma marcação.
  ///
  /// Devolve `true` quando o servidor confirmou. A tela só mostra a confirmação
  /// depois disso — nunca antes.
  Future<bool> punch(TimeEntryType type) async {
    if (state.busy) return false;
    state = state.copyWith(busy: true, clearError: true, clearMessage: true);

    /*
      GPS é EVIDÊNCIA, não permissão (PRD §228).

      Permissão negada, prédio de concreto ou aparelho sem fix produzem uma
      batida válida sem coordenada. Recusar por falta de GPS transferiria ao
      funcionário um problema que não é dele — e ensinaria a não bater ponto.

      A posição é pedida SÓ AQUI, no instante do toque. Nunca em segundo plano.
    */
    final reading = await _location.current();
    final position = reading.position;

    try {
      final workday = await _repository.punch(
        type: type,
        idempotencyKey: _intentKey(type),
        deviceOccurredAt: DateTime.now(),
        latitude: position?.latitude,
        longitude: position?.longitude,
        accuracyMeters: position?.accuracyMeters,
      );

      // Intenção cumprida: a próxima batida deste tipo é um comando novo.
      _intentKeys.remove(timeEntryTypeWire(type));

      state = state.copyWith(
        workday: workday,
        busy: false,
        message: '${timeEntryLabel(type)} registrada.',
        syncStatus: PunchSyncStatus.synced,
      );

      // Relê para trazer a lista de marcações com o horário OFICIAL de cada uma.
      await load();
      state = state.copyWith(lastPunch: state.workday.lastEntry);
      return true;
    } on FieldException catch (error) {
      state = state.copyWith(busy: false, error: error.message);
      if (error.conflict) {
        // O mundo mudou: reler é a saída, não insistir.
        await load();
      }
      return false;
    }
  }

  /// Abre um pedido de correção. `null` em caso de sucesso; a mensagem, se não.
  ///
  /// O horário novo **não é aplicado aqui**. O que sai daqui é um pedido; a
  /// marcação só muda quando alguém aprovar, e mesmo então a original continua
  /// no histórico (PRD §229). Por isso o retorno é uma mensagem de erro ou
  /// nada — nunca uma jornada "já corrigida".
  Future<String?> requestAdjustment({
    required TimeEntryType entryType,
    required DateTime occurredAt,
    required String reason,
    String? targetEntryId,
  }) async {
    // A assinatura da INTENÇÃO. Mesmo pedido, mesma chave, quantas tentativas
    // forem precisas.
    final assinatura = [
      targetEntryId ?? '',
      timeEntryTypeWire(entryType),
      occurredAt.toUtc().toIso8601String(),
      reason.trim(),
    ].join('|');

    try {
      await _repository.requestAdjustment(
        // Apontar para uma marcação existente é CORRIGIR; sem alvo, é INCLUIR
        // o que faltou. O servidor confere que o alvo é da pessoa e do dia.
        requestedType: targetEntryId == null ? 'MISSING_ENTRY' : 'WRONG_TIME',
        requestedEntryType: entryType,
        requestedOccurredAt: occurredAt,
        reason: reason,
        targetEntryId: targetEntryId,
        idempotencyKey: _adjustmentKey(assinatura),
      );

      // Intenção cumprida: um pedido igual, depois disto, é outro comando.
      _adjustmentKeys.remove(assinatura);

      state = state.copyWith(message: 'Correção enviada para aprovação.');
      await load();
      await loadAdjustments();
      return null;
    } on FieldException catch (error) {
      return error.message;
    }
  }

  void consumeMessage() => state = state.copyWith(clearMessage: true);
  void consumeError() => state = state.copyWith(clearError: true);
}

final timeClockRepositoryProvider = Provider<TimeClockRepository>((ref) {
  return TimeClockRepository(api: ref.watch(apiClientProvider));
});

final timeClockControllerProvider =
    StateNotifierProvider<TimeClockController, TimeClockState>((ref) {
      return TimeClockController(
        repository: ref.watch(timeClockRepositoryProvider),
        location: ref.watch(locationServiceProvider),
      );
    });
