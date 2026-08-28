import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/providers.dart';
import '../../../core/errors/field_error.dart';
import '../data/notifications_repository.dart';
import '../domain/app_notification.dart';

@immutable
class NotificationsState {
  const NotificationsState({
    this.items = const [],
    this.nextCursor,
    this.unreadCount = 0,
    this.loading = false,
    this.error,
    this.loaded = false,
  });

  final List<AppNotification> items;
  final String? nextCursor;
  final int unreadCount;
  final bool loading;
  final String? error;
  final bool loaded;

  bool get isEmpty => loaded && items.isEmpty && error == null;

  NotificationsState copyWith({
    List<AppNotification>? items,
    String? nextCursor,
    int? unreadCount,
    bool? loading,
    String? error,
    bool? loaded,
    bool clearError = false,
  }) => NotificationsState(
    items: items ?? this.items,
    nextCursor: nextCursor ?? this.nextCursor,
    unreadCount: unreadCount ?? this.unreadCount,
    loading: loading ?? this.loading,
    error: clearError ? null : (error ?? this.error),
    loaded: loaded ?? this.loaded,
  );
}

class NotificationsController extends StateNotifier<NotificationsState> {
  NotificationsController({required NotificationsRepository repository})
    : _repository = repository,
      super(const NotificationsState());

  final NotificationsRepository _repository;

  Future<void> load() async {
    if (state.loading) return;
    state = state.copyWith(loading: true, clearError: true);
    try {
      final page = await _repository.list();
      state = NotificationsState(
        items: page.items,
        nextCursor: page.nextCursor,
        unreadCount: page.unreadCount,
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

  /// Marca como lidas, com atualização otimista.
  ///
  /// É seguro ser otimista aqui porque a operação é idempotente no servidor e
  /// não muda nada de domínio — o pior desfecho de uma falha é o contador
  /// voltar. Se falhar, o estado é **reconciliado com o backend** em vez de
  /// ficar mentindo na tela.
  Future<void> markRead({List<String>? ids}) async {
    final now = DateTime.now();
    final previous = state;

    state = state.copyWith(
      items: state.items
          .map(
            (n) => (ids == null || ids.contains(n.id)) && n.isUnread
                ? n.markedRead(now)
                : n,
          )
          .toList(),
      unreadCount: ids == null
          ? 0
          : state.items.where((n) => n.isUnread && !ids.contains(n.id)).length,
    );

    try {
      await _repository.markRead(ids: ids);
    } on FieldException catch (_) {
      state = previous;
      await load();
    }
  }
}

final notificationsControllerProvider =
    StateNotifierProvider<NotificationsController, NotificationsState>((ref) {
      return NotificationsController(
        repository: ref.watch(notificationsRepositoryProvider),
      );
    });
