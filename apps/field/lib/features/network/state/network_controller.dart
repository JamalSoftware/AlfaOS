import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/providers.dart';
import '../../../core/api/idempotency.dart';
import '../../../core/errors/field_error.dart';
import '../../orders/state/order_detail_controller.dart';
import '../data/network_repository.dart';
import '../domain/network.dart';

@immutable
class NetworkState {
  const NetworkState({
    this.connection,
    this.loading = false,
    this.loaded = false,
    this.submitting = false,
    this.error,
    this.actionError,
    this.actionMessage,
  });

  /// Onde o cliente está. `null` com `loaded == true` significa **sem
  /// vínculo**; `null` com `loaded == false` significa que ainda não se sabe.
  /// Colapsar os dois faria a tela oferecer "Vincular" antes de ter lido nada.
  final NetworkPlacement? connection;
  final bool loading;
  final bool loaded;
  final bool submitting;

  /// Falha ao CARREGAR a seção.
  final String? error;

  /// Recusa da última mutação. Vive separado de `error` porque a seção
  /// continua legível quando uma ação é recusada — e some quando a próxima
  /// começa.
  final String? actionError;
  final String? actionMessage;

  NetworkState copyWith({
    NetworkPlacement? connection,
    bool? loading,
    bool? loaded,
    bool? submitting,
    String? error,
    String? actionError,
    String? actionMessage,
    bool clearConnection = false,
    bool clearError = false,
    bool clearActionError = false,
    bool clearActionMessage = false,
  }) => NetworkState(
    connection: clearConnection ? null : (connection ?? this.connection),
    loading: loading ?? this.loading,
    loaded: loaded ?? this.loaded,
    submitting: submitting ?? this.submitting,
    error: clearError ? null : (error ?? this.error),
    actionError: clearActionError ? null : (actionError ?? this.actionError),
    actionMessage: clearActionMessage
        ? null
        : (actionMessage ?? this.actionMessage),
  );
}

/// A operação de rede dentro de uma OS.
///
/// ## Online, e só
///
/// `CONNECT`, `DISCONNECT` e `MOVE` **não entram em fila offline**. Este
/// arquivo não importa `PendingOperation`, não persiste intenção e não promete
/// sincronizar depois. Sem rede, a operação não acontece e a tela diz isso —
/// porque duas pessoas reservariam a mesma porta sem servidor, e a
/// reconciliação escolheria um perdedor **depois** de os dois terem subido no
/// poste.
///
/// ## A chave é da INTENÇÃO, e a intenção inclui o destino
///
/// Ela é criada quando o técnico decide, guardada, e reapresentada em cada
/// retentativa. Fosse criada no envio, cada retentativa seria um comando novo
/// para o servidor e a proteção não existiria.
///
/// O escopo inclui o destino porque uma chave presa só à operação seria
/// reapresentada quando o técnico desistisse e escolhesse OUTRA porta — e o
/// servidor recusaria com `IDEMPOTENCY_CONFLICT`, que é a resposta certa para
/// um erro que não deveria ter sido cometido aqui.
class NetworkController extends StateNotifier<NetworkState> {
  NetworkController({
    required NetworkRepository repository,
    required this.orderId,
    Future<void> Function()? onOrderChanged,
  }) : _repository = repository,
       _onOrderChanged = onOrderChanged,
       super(const NetworkState());

  final NetworkRepository _repository;
  final Future<void> Function()? _onOrderChanged;
  final String orderId;

  final Map<String, String> _intentKeys = {};

  String _intentKey(String intent) =>
      _intentKeys[intent] ??= IdempotencyKey.forOperation(intent);

  Future<void> load() async {
    if (!mounted) return;
    state = state.copyWith(loading: true, clearError: true);
    try {
      final connection = await _repository.current(orderId);
      if (!mounted) return;
      state = state.copyWith(
        connection: connection,
        clearConnection: connection == null,
        loading: false,
        loaded: true,
        clearError: true,
      );
    } on FieldException catch (error) {
      if (!mounted) return;
      state = state.copyWith(loading: false, error: error.message);
    }
  }

  /// A OS mudou de versão por causa desta operação: quem mostra a versão
  /// precisa relê-la, senão a mutação seguinte nasce com um token velho.
  Future<void> _syncOrder() async {
    final refresh = _onOrderChanged;
    if (refresh == null) return;
    try {
      await refresh();
    } on FieldException {
      // O vínculo já mudou; falhar a releitura da OS não desfaz isso, e
      // transformar essa falha em erro da operação diria a frase errada.
    }
  }

  Future<bool> connect({
    required int expectedVersion,
    required String ctoPortId,
    required String ctoName,
    required String portLabel,
  }) => _run(
    intent: 'connect:$ctoPortId',
    success: 'Cliente vinculado à porta $portLabel de $ctoName.',
    call: (key) => _repository.connect(
      orderId,
      expectedVersion: expectedVersion,
      ctoPortId: ctoPortId,
      idempotencyKey: key,
    ),
  );

  Future<bool> move({
    required int expectedVersion,
    required String expectedConnectionId,
    required String targetCtoPortId,
    required String ctoName,
    required String portLabel,
  }) => _run(
    intent: 'move:$expectedConnectionId:$targetCtoPortId',
    success: 'Cliente movido para a porta $portLabel de $ctoName.',
    call: (key) => _repository.move(
      orderId,
      expectedVersion: expectedVersion,
      expectedConnectionId: expectedConnectionId,
      targetCtoPortId: targetCtoPortId,
      idempotencyKey: key,
    ),
  );

  Future<bool> disconnect({
    required int expectedVersion,
    required String expectedConnectionId,
    required String portLabel,
  }) => _run(
    intent: 'disconnect:$expectedConnectionId',
    success:
        'Cliente desconectado da porta $portLabel. O histórico foi '
        'preservado.',
    call: (key) => _repository.disconnect(
      orderId,
      expectedVersion: expectedVersion,
      expectedConnectionId: expectedConnectionId,
      idempotencyKey: key,
    ),
  );

  Future<bool> _run({
    required String intent,
    required String success,
    required Future<NetworkMutationResult> Function(String key) call,
  }) async {
    if (state.submitting) return false;
    state = state.copyWith(
      submitting: true,
      clearActionError: true,
      clearActionMessage: true,
    );

    try {
      await call(_intentKey(intent));
      // A intenção foi cumprida: a próxima ação é outra, e merece chave nova.
      _intentKeys.remove(intent);
      if (!mounted) return true;
      state = state.copyWith(submitting: false, actionMessage: success);
      /*
        A leitura vem DEPOIS e do endpoint de leitura, não da resposta da
        mutação: a mutação devolve ids e o número da porta, e a tela precisa do
        nome da caixa e do estado administrativo. Se esta releitura falhar, a
        confirmação continua de pé — ela é verdade, e apagá-la faria o técnico
        repetir uma operação que já aconteceu.
      */
      await load();
      await _syncOrder();
      return true;
    } on FieldException catch (error) {
      if (!mounted) return false;

      if (error.conflict) {
        /*
          O mundo mudou entre a leitura e o toque.
          A chave é descartada porque a intenção que ela representava não existe
          mais, e a seção é RELIDA: insistir mostraria uma porta que já foi
          ocupada, ou um vínculo que já foi encerrado por outra pessoa.
        */
        _intentKeys.remove(intent);
        state = state.copyWith(submitting: false, actionError: error.message);
        await load();
        await _syncOrder();
        return false;
      }

      if (error.code == FieldErrorCode.network) {
        /*
          Sem rede a operação simplesmente NÃO acontece.

          A chave NÃO é descartada — é ela que faz a próxima tentativa ser a
          mesma intenção, e não um segundo comando. E a OS não é relida: se o
          comando tiver chegado ao servidor e só a resposta se perdido, reler
          traria uma versão nova, o corpo mudaria e a retentativa viraria
          `IDEMPOTENCY_CONFLICT` em vez do replay que ela deve ser.
        */
        state = state.copyWith(
          submitting: false,
          actionError:
              'Esta operação precisa de internet. Nada foi enviado — conecte-se '
              'e tente de novo.',
        );
        return false;
      }

      state = state.copyWith(submitting: false, actionError: error.message);
      return false;
    }
  }

  void consumeMessage() => state = state.copyWith(clearActionMessage: true);
  void clearActionError() => state = state.copyWith(clearActionError: true);

  @visibleForTesting
  String debugIntentKey(String intent) => _intentKeys[intent] ?? '';
}

final networkRepositoryProvider = Provider<NetworkRepository>((ref) {
  return NetworkRepository(api: ref.watch(apiClientProvider));
});

final networkControllerProvider = StateNotifierProvider.autoDispose
    .family<NetworkController, NetworkState, String>((ref, orderId) {
      return NetworkController(
        repository: ref.watch(networkRepositoryProvider),
        orderId: orderId,
        /*
          A mutação de rede reivindica a OS e move `version`. Quem exibe a OS
          precisa relê-la, senão a operação seguinte nasce com um token velho e
          o técnico leva um 409 que não é culpa dele.
        */
        onOrderChanged: () =>
            ref.read(orderDetailControllerProvider(orderId).notifier).load(),
      );
    });
