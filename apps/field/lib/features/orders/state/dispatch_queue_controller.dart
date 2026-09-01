import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/providers.dart';
import '../../../core/errors/field_error.dart';
import '../data/orders_repository.dart';
import '../domain/dispatch_queue.dart';

/// # A fila operacional, do jeito que o despacho a definiu (DQ-6)
///
/// Uma fonte só, lida pelo Início e por Minhas Ordens. Duas leituras do mesmo
/// endpoint em telas diferentes produziriam duas ordens na mesma sessão — que
/// é o problema que esta fase existe para acabar, só que dentro do aplicativo.
///
/// ## Três desfechos, e eles NÃO se misturam
///
/// ```text
/// fila disponível   ordena pelo servidor, sempre
/// indisponível      servidor anterior à DQ-5 (404): ranking local, MARCADO
/// erro              nada é ordenado; a tela oferece tentar de novo
/// ```
///
/// A distinção entre os dois últimos é o ponto. Cair no ranking local porque a
/// rede falhou apresentaria uma ordem inventada como se fosse a do
/// despachante — e o técnico atenderia na sequência errada achando que está
/// certo. **Fallback é para servidor antigo, nunca para rede ruim.**
@immutable
class DispatchQueueState {
  const DispatchQueueState({
    this.queue,
    this.loading = false,
    this.loaded = false,
    this.error,
    this.unavailable = false,
  });

  final DispatchQueue? queue;
  final bool loading;

  /// Já houve pelo menos uma resposta. Distingue "carregando" de "vazia".
  final bool loaded;
  final String? error;

  /// O servidor não oferece a fila (rota ausente). **Só então** o ranking
  /// local volta a valer, e a tela diz que está em modo de compatibilidade.
  final bool unavailable;

  /// Há ordem autoritativa para obedecer?
  bool get authoritative => queue != null;

  DispatchQueueState copyWith({
    DispatchQueue? queue,
    bool? loading,
    bool? loaded,
    String? error,
    bool? unavailable,
    bool clearError = false,
    bool clearQueue = false,
  }) => DispatchQueueState(
    queue: clearQueue ? null : (queue ?? this.queue),
    loading: loading ?? this.loading,
    loaded: loaded ?? this.loaded,
    error: clearError ? null : (error ?? this.error),
    unavailable: unavailable ?? this.unavailable,
  );
}

class DispatchQueueController extends StateNotifier<DispatchQueueState> {
  DispatchQueueController({required OrdersRepository repository})
    : _repository = repository,
      super(const DispatchQueueState());

  final OrdersRepository _repository;

  Future<void> load() async {
    if (state.loading) return;
    state = state.copyWith(loading: true, clearError: true);
    try {
      final queue = await _repository.dispatchQueue();
      state = DispatchQueueState(
        queue: queue,
        loaded: true,
        unavailable: queue == null,
      );
    } on FieldException catch (error) {
      /*
        O estado ANTERIOR é preservado.

        Uma atualização que falha não apaga a fila que o técnico já tem na
        tela: ele fica com a ordem de dois minutos atrás e a informação de que
        ela não pôde ser atualizada — em vez de uma tela vazia no meio do
        atendimento. É o mesmo cuidado do diagnóstico, onde falhar não vira
        `OFFLINE`.
      */
      state = state.copyWith(
        loading: false,
        loaded: true,
        error: error.message,
      );
    }
  }
}

final dispatchQueueControllerProvider =
    StateNotifierProvider<DispatchQueueController, DispatchQueueState>((ref) {
      return DispatchQueueController(
        repository: ref.watch(ordersRepositoryProvider),
      );
    });
