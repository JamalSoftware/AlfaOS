import 'package:alfaos_field/core/logging/log.dart';
import 'package:alfaos_field/features/orders/ui/order_detail_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/harness.dart';

/// Afirmações de segurança que precisam falhar se alguém as quebrar.
///
/// Não são testes de funcionalidade: cada um existe porque a violação
/// correspondente seria invisível numa revisão de código apressada.
void main() {
  final detalhe = <String, dynamic>{
    'serviceOrder': {
      'id': 'os-1',
      'number': 7,
      'status': 'ASSIGNED',
      'priority': 'NORMAL',
      'type': 'Instalação',
      'subtype': null,
      'description': 'Sem sinal.',
      'scheduledAt': null,
      'assignedAt': null,
      'startedAt': null,
      'updatedAt': '2026-08-27T10:00:00.000Z',
      'version': 3,
      'customer': <String, dynamic>{
        'name': 'Maria da Silva',
        'phone': '(28) 99999-0001',
        'secondaryPhone': null,
        'address': 'Rua das Flores',
        'number': '84',
        'complement': null,
        'district': 'Centro',
        'city': 'Guaçuí',
        'state': 'ES',
        'zipCode': '29560-000',
        'latitude': -20.7746,
        'longitude': -41.6789,
      },
      'connection': {
        'id': 'conn-1',
        'type': 'PPPOE',
        'username': '11-teixeira-ftth',
        'passwordConfigured': true,
      },
      'execution': null,
      'diagnostic': null,
    },
  };

  testWidgets('a senha revelada NÃO chega a nenhum armazenamento', (
    tester,
  ) async {
    // Superfície alta: o bloco de PPPoE fica abaixo de 600dp e não seria
    // construído na janela padrão do teste.
    final view =
        TestWidgetsFlutterBinding.instance.platformDispatcher.implicitView!;
    view.physicalSize = const Size(1080, 3000);
    view.devicePixelRatio = 1.0;
    addTearDown(() {
      view.resetPhysicalSize();
      view.resetDevicePixelRatio();
    });

    final h = Harness();
    h.transport.onJson('GET', '/service-orders/os-1', data: detalhe);
    h.transport.onJson(
      'POST',
      '/service-orders/os-1/pppoe/reveal',
      data: {'password': 'senha-pppoe-real-123'},
    );

    await h.pump(tester, const OrderDetailScreen(orderId: 'os-1'));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('pppoe-reveal')));
    await tester.pumpAndSettle();

    // Está na tela, viva em memória.
    expect(find.text('senha-pppoe-real-123'), findsOneWidget);

    /*
      E em lugar nenhum durável.

      Cache offline é armazenamento durável num aparelho que anda pela rua e é
      roubado. Toda a arquitetura da revelação sob demanda — no-store, auditoria
      obrigatória, teto de frequência — seria anulada em silêncio por uma única
      gravação em disco.
    */
    expect(h.store.token, isNull);
    expect(
      h.store.insecureWrites.values.join(' '),
      isNot(contains('senha-pppoe-real-123')),
    );

    // Ocultar descarta de vez: não é só esconder.
    await tester.tap(find.byKey(const Key('pppoe-hide')));
    await tester.pumpAndSettle();
    expect(find.text('senha-pppoe-real-123'), findsNothing);
    expect(find.text('••••'), findsOneWidget);
  });

  test('o log jamais imprime um cabeçalho de autorização', () {
    final saida = Log.redact({
      'headers': {
        'Authorization': 'Bearer token-super-secreto',
        'Idempotency-Key': 'start-abc',
      },
      'body': {'password': 'senha123'},
    }).toString();

    expect(saida, isNot(contains('token-super-secreto')));
    expect(saida, isNot(contains('senha123')));
    // Controle positivo: o que não é segredo continua legível, senão a função
    // poderia estar simplesmente apagando tudo.
    expect(saida, contains('start-abc'));
  });

  test('o token nunca é gravado no armazenamento comum', () async {
    final h = Harness();
    await h.store.writeToken('token-de-sessao');
    await h.store.installationId();

    /*
      Os dois lugares existem separados por segurança, não por organização:
      token no cofre da plataforma (Keystore), `installationId` — que não é
      segredo — nas preferências comuns.
    */
    expect(h.store.token, 'token-de-sessao');
    expect(
      h.store.insecureWrites.values.join(' '),
      isNot(contains('token-de-sessao')),
    );
    expect(h.store.insecureWrites['installationId'], isNotNull);
  });

  testWidgets('o payload da tela não contém CPF nem dado de provedor', (
    tester,
  ) async {
    final h = Harness();
    h.transport.onJson('GET', '/service-orders/os-1', data: detalhe);
    await h.pump(tester, const OrderDetailScreen(orderId: 'os-1'));
    await tester.pumpAndSettle();

    // O backend nem envia esses campos; o modelo não os tem. Este teste é a
    // rede: se alguém acrescentar um deles ao DTO, ele falha.
    final textos = tester
        .widgetList<Text>(find.byType(Text))
        .map((t) => t.data ?? '')
        .join(' ');

    for (final proibido in [
      'RECEITANET',
      'externalId',
      'externalProvider',
      'CPF',
      '12345678901',
    ]) {
      expect(textos, isNot(contains(proibido)), reason: proibido);
    }
  });
}
