import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/providers.dart';
import '../../../core/errors/field_error.dart';
import '../data/orders_repository.dart';
import '../domain/service_order.dart';

/// Estado da fila de OS do técnico.
@immutable
class OrdersState {
  const OrdersState({
    this.items = const [],
    this.nextCursor,
    this.loading = false,
    this.loadingMore = false,
    this.error,
    this.loaded = false,
  });

  final List<OrderSummary> items;
  final String? nextCursor;
  final bool loading;
  final bool loadingMore;
  final String? error;

  /// Já houve pelo menos uma resposta. Distingue "ainda carregando" de "lista
  /// realmente vazia" — sem isso a tela mostraria "nenhuma ordem" no primeiro
  /// frame, que é pior do que um spinner.
  final bool loaded;

  bool get isEmpty => loaded && items.isEmpty && error == null;
  bool get hasMore => nextCursor != null;

  /// Em atendimento primeiro. O que o técnico está fazendo AGORA é o item que
  /// ele mais precisa reencontrar; enterrá-lo no meio da lista transforma o
  /// mais urgente no mais difícil de achar.
  List<OrderSummary> get inProgress =>
      items.where((o) => o.status == OrderStatus.inProgress).toList();

  List<OrderSummary> get assigned =>
      items.where((o) => o.status != OrderStatus.inProgress).toList();

  OrdersState copyWith({
    List<OrderSummary>? items,
    String? nextCursor,
    bool? loading,
    bool? loadingMore,
    String? error,
    bool? loaded,
    bool clearError = false,
    bool clearCursor = false,
  }) => OrdersState(
    items: items ?? this.items,
    nextCursor: clearCursor ? null : (nextCursor ?? this.nextCursor),
    loading: loading ?? this.loading,
    loadingMore: loadingMore ?? this.loadingMore,
    error: clearError ? null : (error ?? this.error),
    loaded: loaded ?? this.loaded,
  );
}

class OrdersController extends StateNotifier<OrdersState> {
  OrdersController({required OrdersRepository repository})
    : _repository = repository,
      super(const OrdersState());

  final OrdersRepository _repository;

  Future<void> load({bool refresh = false}) async {
    if (state.loading) return;
    state = state.copyWith(loading: true, clearError: true);
    try {
      final page = await _repository.list();
      state = OrdersState(
        items: page.items,
        nextCursor: page.nextCursor,
        loaded: true,
      );
    } on FieldException catch (error) {
      state = state.copyWith(
        loading: false,
        loaded: true,
        error: error.message,
      );
    }
  }

  /// Próxima página.
  ///
  /// O cursor vem do servidor e é reenviado como veio. Guardas contra laço:
  /// não carrega se já está carregando, e não repete um cursor que não avançou
  /// — um cursor que se repetisse faria a lista crescer para sempre com os
  /// mesmos itens.
  Future<void> loadMore() async {
    final cursor = state.nextCursor;
    if (cursor == null || state.loadingMore || state.loading) return;

    state = state.copyWith(loadingMore: true);
    try {
      final page = await _repository.list(cursor: cursor);
      final known = state.items.map((o) => o.id).toSet();
      final novos = page.items.where((o) => !known.contains(o.id)).toList();
      state = state.copyWith(
        items: [...state.items, ...novos],
        nextCursor: page.nextCursor == cursor ? null : page.nextCursor,
        clearCursor: page.nextCursor == null,
        loadingMore: false,
      );
    } on FieldException catch (error) {
      state = state.copyWith(loadingMore: false, error: error.message);
    }
  }
}

final ordersControllerProvider =
    StateNotifierProvider<OrdersController, OrdersState>((ref) {
      return OrdersController(repository: ref.watch(ordersRepositoryProvider));
    });
