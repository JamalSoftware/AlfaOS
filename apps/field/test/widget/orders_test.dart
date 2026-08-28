import 'package:alfaos_field/features/orders/domain/service_order.dart';
import 'package:alfaos_field/features/orders/ui/order_card.dart';
import 'package:alfaos_field/features/orders/ui/orders_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/harness.dart';

Map<String, dynamic> item({
  String id = 'os-1',
  int number = 7,
  String status = 'ASSIGNED',
  String priority = 'NORMAL',
  String customerName = 'Maria da Silva',
  String? district = 'Centro',
  String? city = 'Guaçuí',
  bool hasLocation = true,
}) => {
  'id': id,
  'number': number,
  'status': status,
  'priority': priority,
  'type': 'Instalação',
  'subtype': null,
  'customerName': customerName,
  'district': district,
  'city': city,
  'scheduledAt': null,
  'hasLocation': hasLocation,
  'updatedAt': '2026-08-27T10:00:00.000Z',
  'version': 1,
};

void main() {
  testWidgets('carregando mostra progresso', (tester) async {
    final h = Harness();
    h.transport.onJson('GET', '/service-orders', data: {'items': []});
    await h.pump(tester, const OrdersScreen());

    await tester.pump();
    expect(find.byType(CircularProgressIndicator), findsWidgets);
    await tester.pumpAndSettle();
  });

  testWidgets('lista vazia mostra estado vazio, não erro', (tester) async {
    final h = Harness();
    h.transport.onJson(
      'GET',
      '/service-orders',
      data: {'items': [], 'nextCursor': null},
    );
    await h.pump(tester, const OrdersScreen());
    await tester.pumpAndSettle();

    // Lista vazia é resposta legítima. Um erro vermelho aqui ensinaria o
    // técnico a ignorar erros vermelhos.
    expect(find.text('Nenhuma ordem atribuída no momento.'), findsOneWidget);
    expect(find.textContaining('Não foi possível'), findsNothing);
  });

  testWidgets('erro mostra mensagem operacional com saída', (tester) async {
    final h = Harness();
    h.transport.offline = true;
    await h.pump(tester, const OrdersScreen());
    await tester.pumpAndSettle();

    expect(find.text('Não foi possível carregar suas ordens.'), findsOneWidget);
    expect(find.text('Tentar novamente'), findsOneWidget);
    // Nada de exceção do Dio, corpo cru ou stack na tela.
    expect(find.textContaining('DioException'), findsNothing);
  });

  testWidgets('renderiza os cards e agrupa em atendimento primeiro', (
    tester,
  ) async {
    final h = Harness();
    h.transport.onJson(
      'GET',
      '/service-orders',
      data: {
        'items': [
          item(id: 'a', number: 7),
          item(id: 'b', number: 8, status: 'IN_PROGRESS'),
        ],
        'nextCursor': null,
      },
    );
    await h.pump(tester, const OrdersScreen());
    await tester.pumpAndSettle();

    expect(find.byType(OrderCard), findsNWidgets(2));
    expect(find.text('EM ATENDIMENTO'), findsOneWidget);
    expect(find.text('ATRIBUÍDAS'), findsOneWidget);

    // O que ele está fazendo AGORA vem antes do resto.
    final emAtendimento = tester.getTopLeft(find.text('EM ATENDIMENTO')).dy;
    final atribuidas = tester.getTopLeft(find.text('ATRIBUÍDAS')).dy;
    expect(emAtendimento, lessThan(atribuidas));
  });

  testWidgets('o card não mostra dado administrativo nem de provedor', (
    tester,
  ) async {
    final h = Harness();
    h.transport.onJson(
      'GET',
      '/service-orders',
      data: {
        'items': [item()],
        'nextCursor': null,
      },
    );
    await h.pump(tester, const OrdersScreen());
    await tester.pumpAndSettle();

    expect(find.text('OS Nº 7'), findsOneWidget);
    expect(find.text('Maria da Silva'), findsOneWidget);
    expect(find.text('Centro · Guaçuí'), findsOneWidget);

    // Nada de id técnico, provedor ou CPF — o backend nem os envia.
    expect(find.textContaining('os-1'), findsNothing);
    expect(find.textContaining('RECEITANET'), findsNothing);
    expect(find.textContaining('externalId'), findsNothing);
  });

  testWidgets('prioridade normal não ganha destaque; urgente ganha', (
    tester,
  ) async {
    final h = Harness();
    h.transport.onJson(
      'GET',
      '/service-orders',
      data: {
        'items': [
          item(id: 'a', priority: 'NORMAL'),
          item(id: 'b', number: 8, priority: 'URGENT'),
        ],
        'nextCursor': null,
      },
    );
    await h.pump(tester, const OrdersScreen());
    await tester.pumpAndSettle();

    // Pintar todas as prioridades faria o urgente deixar de saltar.
    expect(find.text('Urgente'), findsOneWidget);
    expect(find.text('Normal'), findsNothing);
  });

  testWidgets('sem bairro nem cidade, não escreve "null"', (tester) async {
    final h = Harness();
    h.transport.onJson(
      'GET',
      '/service-orders',
      data: {
        'items': [item(district: null, city: null)],
        'nextCursor': null,
      },
    );
    await h.pump(tester, const OrdersScreen());
    await tester.pumpAndSettle();

    expect(find.textContaining('null'), findsNothing);
  });

  testWidgets('status desconhecido não quebra a tela', (tester) async {
    final h = Harness();
    h.transport.onJson(
      'GET',
      '/service-orders',
      data: {
        'items': [item(status: 'ESTADO_DO_FUTURO')],
        'nextCursor': null,
      },
    );
    await h.pump(tester, const OrdersScreen());
    await tester.pumpAndSettle();

    expect(find.byType(OrderCard), findsOneWidget);
    expect(find.text(OrderStatus.unknown.label), findsOneWidget);
  });
}
