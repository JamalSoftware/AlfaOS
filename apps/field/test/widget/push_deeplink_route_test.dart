import 'package:alfaos_field/app/providers.dart';
import 'package:alfaos_field/core/push/field_push_service.dart';
import 'package:alfaos_field/features/orders/ui/order_detail_screen.dart';
import 'package:alfaos_field/features/auth/ui/login_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_push_service.dart';
import '../support/fake_transport.dart';
import '../support/harness.dart';

/// # O deep link contra o `GoRouter` REAL (`NF-4`)
///
/// Os testes de unidade da fase injetam um roteador falso, e por isso provam a
/// DECISÃO — quando navegar, quando esperar, quando ignorar. O que eles não
/// tocam é a expressão que roda em produção: `ref.read(routerProvider).push(...)`
/// sobre um `GoRouter` que é **recriado a cada troca de fase da sessão**.
///
/// A auditoria da fase levantou exatamente essa lacuna: o destino pendente é
/// consumido por um `ref.listen` sobre a fase, ou seja, no mesmo instante em
/// que o roteador nasce de novo. Se um `push` nesse momento fosse descartado, o
/// cenário principal da `NF-4` — abrir pelo aviso sem sessão, entrar, cair na
/// OS — falharia em silêncio, e nenhum teste de unidade acusaria.
///
/// Este arquivo fecha isso montando o aplicativo inteiro.

const _osId = 'cmtmcq50u00b6vudsw9tgcio1';

void seedAuthenticated(FakeTransport transport) {
  transport.onJson(
    'GET',
    '/me',
    data: {
      'user': {'id': 'u1', 'name': 'Tecnico Alfa', 'email': 't@a.test'},
      'technician': {'id': 't1', 'active': true, 'executionIssue': null},
      'company': {'id': 'c1', 'name': 'Alfa Telecom'},
      'device': {'id': 'd1', 'platform': 'ANDROID'},
      'capabilities': {'startOrder': true},
    },
  );
  transport.onJson(
    'GET',
    '/service-orders',
    data: {'items': [], 'nextCursor': null},
  );
  transport.onJson(
    'GET',
    '/dispatch-queue',
    data: {'entries': [], 'inProgress': []},
  );
  transport.onJson('GET', '/notifications', data: {'items': [], 'unread': 0});
  transport.onJson('GET', '/time-clock/today', data: {});
  transport.onJson('POST', '/devices/register', data: {'device': {}});
  transport.onJson(
    'GET',
    '/service-orders/$_osId',
    data: {
      'serviceOrder': {
        'id': _osId,
        'number': 7,
        'status': 'ASSIGNED',
        'priority': 'NORMAL',
        'type': 'Instalação',
        'subtype': null,
        'description': 'Instalação de fibra.',
        'version': 0,
        'customer': {
          'name': 'Maria da Silva',
          'district': 'Centro',
          'city': 'Guaçuí',
          'address': 'Rua das Flores',
          'number': '84',
        },
      },
    },
  );
}

IncomingPush avisoDaOs() => const IncomingPush(
  data: {
    'type': 'SERVICE_ORDER_ASSIGNED',
    'resourceType': 'ServiceOrder',
    'resourceId': _osId,
  },
  messageId: 'msg-piloto',
);

Future<void> assentar(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 60));
  }
  await tester.pumpAndSettle(const Duration(milliseconds: 50));
}

void main() {
  testWidgets('aberto por um aviso COM sessão: cai direto na OS', (
    tester,
  ) async {
    final harness = Harness();
    seedAuthenticated(harness.transport);
    harness.store.token = 'token-seedado';

    final push = FakePushService()..mensagemInicial = avisoDaOs();

    await harness.pumpApp(
      tester,
      extraOverrides: [fieldPushServiceProvider.overrideWithValue(push)],
    );
    await assentar(tester);

    expect(find.byType(OrderDetailScreen), findsOneWidget);
    expect(find.text('OS Nº 7'), findsAtLeastNWidgets(1));
  });

  testWidgets('aberto por um aviso SEM sessão: login primeiro, OS depois', (
    tester,
  ) async {
    final harness = Harness();
    seedAuthenticated(harness.transport);
    harness.transport.onJson(
      'POST',
      '/auth/login',
      data: {'token': 'token-do-login'},
    );
    // Sem token guardado: o aplicativo abre na tela de entrada.

    final push = FakePushService()..mensagemInicial = avisoDaOs();

    await harness.pumpApp(
      tester,
      extraOverrides: [fieldPushServiceProvider.overrideWithValue(push)],
    );
    await assentar(tester);

    // O aviso NÃO abriu nada: a porta é o login.
    expect(find.byType(LoginScreen), findsOneWidget);
    expect(find.byType(OrderDetailScreen), findsNothing);

    await tester.enterText(
      find.byKey(const Key('login-email')),
      'tech@alfa.test',
    );
    await tester.enterText(find.byKey(const Key('login-password')), 'segredo');
    await tester.tap(find.byKey(const Key('login-submit')));
    await assentar(tester);

    /*
      A prova da fase: o destino sobreviveu ao login e foi consumido contra o
      `GoRouter` de verdade — que, nesse exato instante, acabou de ser
      reconstruído pela troca de fase da sessão.
    */
    expect(find.byType(OrderDetailScreen), findsOneWidget);
    expect(find.text('OS Nº 7'), findsAtLeastNWidgets(1));
  });

  testWidgets('sem aviso nenhum, a abertura continua no Início', (
    tester,
  ) async {
    /*
      Controle negativo. Sem ele, os dois testes acima poderiam estar passando
      por qualquer motivo — inclusive por a tela de detalhe aparecer sozinha.
    */
    final harness = Harness();
    seedAuthenticated(harness.transport);
    harness.store.token = 'token-seedado';

    await harness.pumpApp(
      tester,
      extraOverrides: [
        fieldPushServiceProvider.overrideWithValue(FakePushService()),
      ],
    );
    await assentar(tester);

    expect(find.byType(OrderDetailScreen), findsNothing);
  });
}
