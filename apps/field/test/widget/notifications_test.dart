import 'package:alfaos_field/features/notifications/ui/notifications_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/harness.dart';

Map<String, dynamic> notification({
  String id = 'n1',
  String title = 'Nova OS atribuída',
  String body = 'OS Nº 7 · Instalação',
  String? readAt,
  String? resourceId = 'os-1',
}) => {
  'id': id,
  'type': 'SERVICE_ORDER_ASSIGNED',
  'title': title,
  'body': body,
  'resourceType': resourceId == null ? null : 'ServiceOrder',
  'resourceId': resourceId,
  'readAt': readAt,
  'createdAt': DateTime.now()
      .subtract(const Duration(minutes: 3))
      .toIso8601String(),
};

void main() {
  testWidgets('vazio não é erro', (tester) async {
    final h = Harness();
    h.transport.onJson(
      'GET',
      '/notifications',
      data: {'items': [], 'nextCursor': null, 'unreadCount': 0},
    );
    await h.pump(tester, const NotificationsScreen());
    await tester.pumpAndSettle();

    expect(find.text('Nenhuma notificação.'), findsOneWidget);
    expect(find.textContaining('Não foi possível'), findsNothing);
  });

  testWidgets('lista título, corpo e tempo', (tester) async {
    final h = Harness();
    h.transport.onJson(
      'GET',
      '/notifications',
      data: {
        'items': [notification()],
        'nextCursor': null,
        'unreadCount': 1,
      },
    );
    await h.pump(tester, const NotificationsScreen());
    await tester.pumpAndSettle();

    expect(find.text('Nova OS atribuída'), findsOneWidget);
    expect(find.text('OS Nº 7 · Instalação'), findsOneWidget);
    expect(find.text('3 min'), findsOneWidget);
  });

  testWidgets('o corpo da notificação não carrega dado pessoal', (
    tester,
  ) async {
    final h = Harness();
    h.transport.onJson(
      'GET',
      '/notifications',
      data: {
        'items': [notification()],
        'nextCursor': null,
        'unreadCount': 1,
      },
    );
    await h.pump(tester, const NotificationsScreen());
    await tester.pumpAndSettle();

    /*
      O texto vem pronto do servidor e é redigido para caber na tela bloqueada:
      número operacional e tipo. O app não o enriquece com nome, endereço ou
      telefone — a prévia do push é a superfície menos controlada do produto.
    */
    expect(find.textContaining('Maria'), findsNothing);
    expect(find.textContaining('Rua'), findsNothing);
    expect(find.textContaining('99999'), findsNothing);
  });

  testWidgets('"marcar todas" só aparece quando há não lidas', (tester) async {
    final h = Harness();
    h.transport.onJson(
      'GET',
      '/notifications',
      data: {
        'items': [notification(readAt: '2026-08-27T10:00:00.000Z')],
        'nextCursor': null,
        'unreadCount': 0,
      },
    );
    await h.pump(tester, const NotificationsScreen());
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('notifications-mark-all')), findsNothing);
  });

  testWidgets('marcar todas chama o servidor', (tester) async {
    final h = Harness();
    h.transport.onJson(
      'GET',
      '/notifications',
      data: {
        'items': [notification()],
        'nextCursor': null,
        'unreadCount': 1,
      },
    );
    h.transport.onJson('POST', '/notifications', data: {'updated': 1});

    await h.pump(tester, const NotificationsScreen());
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('notifications-mark-all')));
    await tester.pumpAndSettle();

    expect(h.transport.countOf('POST', '/notifications'), 1);
    // Sem `ids`: o contrato marca todas as não lidas.
    expect(
      (h.transport.requestFor('POST', '/notifications').data as Map)
          .containsKey('ids'),
      isFalse,
    );
  });

  testWidgets('falha ao marcar reconcilia com o backend', (tester) async {
    final h = Harness();
    h.transport.onJson(
      'GET',
      '/notifications',
      data: {
        'items': [notification()],
        'nextCursor': null,
        'unreadCount': 1,
      },
    );
    h.transport.onError(
      'POST',
      '/notifications',
      status: 500,
      code: 'INTERNAL',
    );

    await h.pump(tester, const NotificationsScreen());
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('notifications-mark-all')));
    await tester.pumpAndSettle();

    /*
      A atualização otimista é segura aqui porque a operação é idempotente e não
      muda domínio. Quando falha, o app RECARREGA em vez de continuar mostrando
      um estado que o servidor não tem.
    */
    expect(h.transport.countOf('GET', '/notifications'), 2);
  });
}
