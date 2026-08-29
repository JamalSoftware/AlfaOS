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
    this.loading = true,
    this.busy = false,
    this.error,
    this.message,
    this.lastPunch,
    this.syncStatus = PunchSyncStatus.synced,
  });

  final Workday workday;
  final List<WorkdaySummary> history;
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

  TimeClockState copyWith({
    Workday? workday,
    List<WorkdaySummary>? history,
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
  Future<String?> requestAdjustment({
    required TimeEntryType entryType,
    required DateTime occurredAt,
    required String reason,
  }) async {
    try {
      await _repository.requestAdjustment(
        requestedEntryType: entryType,
        requestedOccurredAt: occurredAt,
        reason: reason,
        idempotencyKey: IdempotencyKey.forOperation('time-clock-adjustment'),
      );
      state = state.copyWith(message: 'Correção solicitada.');
      await load();
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
