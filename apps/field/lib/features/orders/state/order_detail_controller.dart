import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/providers.dart';
import '../../../core/api/idempotency.dart';
import '../../../core/errors/field_error.dart';
import '../data/orders_repository.dart';
import '../domain/service_order.dart';

@immutable
class OrderDetailState {
  const OrderDetailState({
    this.order,
    this.loading = true,
    this.error,
    this.notFound = false,
    this.starting = false,
    this.actionMessage,
    this.revealedPassword,
    this.revealing = false,
    this.refreshingDiagnostic = false,
    this.diagnosticWarning,
  });

  final OrderDetail? order;
  final bool loading;
  final String? error;

  /// A OS não é mais deste técnico — reatribuída, ou id inexistente. Merece
  /// tela própria: não é falha, é uma mudança legítima da operação.
  final bool notFound;

  final bool starting;

  /// Aviso passageiro sobre a última ação. Some ao ser exibido.
  final String? actionMessage;

  /// Senha em claro, viva **apenas** em memória e apenas enquanto a tela está
  /// aberta. Nunca é gravada em disco.
  final String? revealedPassword;
  final bool revealing;

  final bool refreshingDiagnostic;

  /// A releitura falhou, mas o estado anterior continua válido. **Erro não é
  /// OFFLINE.**
  final String? diagnosticWarning;

  OrderDetailState copyWith({
    OrderDetail? order,
    bool? loading,
    String? error,
    bool? notFound,
    bool? starting,
    String? actionMessage,
    String? revealedPassword,
    bool? revealing,
    bool? refreshingDiagnostic,
    String? diagnosticWarning,
    bool clearError = false,
    bool clearMessage = false,
    bool clearPassword = false,
    bool clearDiagnosticWarning = false,
  }) => OrderDetailState(
    order: order ?? this.order,
    loading: loading ?? this.loading,
    error: clearError ? null : (error ?? this.error),
    notFound: notFound ?? this.notFound,
    starting: starting ?? this.starting,
    actionMessage: clearMessage ? null : (actionMessage ?? this.actionMessage),
    revealedPassword: clearPassword
        ? null
        : (revealedPassword ?? this.revealedPassword),
    revealing: revealing ?? this.revealing,
    refreshingDiagnostic: refreshingDiagnostic ?? this.refreshingDiagnostic,
    diagnosticWarning: clearDiagnosticWarning
        ? null
        : (diagnosticWarning ?? this.diagnosticWarning),
  );
}

class OrderDetailController extends StateNotifier<OrderDetailState> {
  OrderDetailController({
    required OrdersRepository repository,
    required this.orderId,
  }) : _repository = repository,
       super(const OrderDetailState());

  final OrdersRepository _repository;
  final String orderId;

  /// Chave da INTENÇÃO de iniciar.
  ///
  /// Criada no primeiro toque e reusada em toda retentativa daquela intenção. É
  /// isso que faz a idempotência funcionar: gerada a cada envio, o servidor
  /// veria comandos distintos e a proteção não existiria.
  String? _startIntentKey;

  Future<void> load() async {
    state = state.copyWith(loading: true, clearError: true, notFound: false);
    try {
      final order = await _repository.detail(orderId);
      state = state.copyWith(order: order, loading: false, clearError: true);
    } on FieldException catch (error) {
      if (error.code == FieldErrorCode.notFound) {
        state = state.copyWith(loading: false, notFound: true);
        return;
      }
      state = state.copyWith(loading: false, error: error.message);
    }
  }

  /// Inicia o atendimento.
  ///
  /// Envia `expectedVersion` (a versão que a tela leu) e a chave de
  /// idempotência. O estado novo vem do RETORNO da mutação — não de uma
  /// releitura, que poderia responder 404 se a OS fosse reatribuída entre o
  /// commit e a resposta.
  Future<void> start() async {
    final order = state.order;
    if (order == null || state.starting) return;

    _startIntentKey ??= IdempotencyKey.forOperation('start');
    state = state.copyWith(
      starting: true,
      clearError: true,
      clearMessage: true,
    );

    try {
      final result = await _repository.start(
        orderId: order.id,
        expectedVersion: order.version,
        idempotencyKey: _startIntentKey!,
      );
      state = state.copyWith(
        order: order.withStartResult(
          status: result.status,
          startedAt: result.startedAt,
          updatedAt: result.updatedAt,
          version: result.version,
          execution: result.execution,
        ),
        starting: false,
        actionMessage: 'Atendimento iniciado.',
      );
      // A intenção se cumpriu; a próxima seria outra.
      _startIntentKey = null;
    } on FieldException catch (error) {
      state = state.copyWith(starting: false);
      if (error.conflict) {
        /*
          O servidor mudou debaixo do aparelho.

          Recarrega em vez de reenviar: quem decide é o domínio, e insistir com
          uma versão velha só produziria o mesmo 409. A chave da intenção é
          descartada porque o mundo que ela representava não existe mais.
        */
        _startIntentKey = null;
        state = state.copyWith(
          actionMessage:
              'A ordem foi atualizada em outro lugar. Recarregando...',
        );
        await load();
        return;
      }
      state = state.copyWith(error: error.message);
    }
  }

  /// Revela a senha da conexão.
  ///
  /// O valor fica **só em memória**, nesta tela. Sair descarta.
  Future<void> revealPassword() async {
    final order = state.order;
    final connection = order?.connection;
    if (order == null || connection == null || state.revealing) return;

    state = state.copyWith(revealing: true, clearError: true);
    try {
      final password = await _repository.revealConnectionPassword(
        orderId: order.id,
        connectionId: connection.id,
      );
      state = state.copyWith(revealedPassword: password, revealing: false);
    } on FieldException catch (error) {
      state = state.copyWith(revealing: false, error: error.message);
    }
  }

  /// Volta à máscara e **descarta o texto claro**.
  void hidePassword() => state = state.copyWith(clearPassword: true);

  Future<void> refreshDiagnostic() async {
    final order = state.order;
    if (order == null || state.refreshingDiagnostic) return;

    state = state.copyWith(
      refreshingDiagnostic: true,
      clearDiagnosticWarning: true,
    );
    try {
      final result = await _repository.refreshDiagnostic(order.id);
      state = state.copyWith(
        order: order.withDiagnostic(result.diagnostic),
        refreshingDiagnostic: false,
        // Falha de leitura NÃO vira OFFLINE: o último estado válido continua,
        // e o aviso diz que ele é velho.
        diagnosticWarning: result.ok
            ? null
            : (result.errorMessage ?? 'Não foi possível atualizar agora.'),
      );
    } on FieldException catch (error) {
      state = state.copyWith(
        refreshingDiagnostic: false,
        diagnosticWarning: error.code == FieldErrorCode.rateLimited
            ? 'Muitas solicitações. Tente novamente em instantes.'
            : 'Não foi possível atualizar agora.',
      );
    }
  }

  void consumeMessage() => state = state.copyWith(clearMessage: true);
}

final orderDetailControllerProvider =
    StateNotifierProvider.family<
      OrderDetailController,
      OrderDetailState,
      String
    >((ref, orderId) {
      return OrderDetailController(
        repository: ref.watch(ordersRepositoryProvider),
        orderId: orderId,
      );
    });
