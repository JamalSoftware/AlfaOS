import 'dart:async';

import 'package:alfaos_field/app/providers.dart';
import 'package:alfaos_field/core/push/field_push_service.dart';
import 'package:alfaos_field/features/notifications/state/notifications_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/fake_push_service.dart';
import '../support/fake_transport.dart';
import '../support/harness.dart';

/// # O sino conta o que o BACKEND diz (`NF-5`)
///
/// O piloto físico encontrou o defeito que nenhum teste desta trilha via: o
/// aplicativo estava **encerrado**, uma OS foi atribuída, o worker entregou o
/// push (`reivindicados=1 processados=1`), a notificação nativa chegou, o
/// técnico abriu — e o sino continuou no número antigo.
///
/// A causa era de wiring, não de cálculo: a contagem só era lida em dois
/// lugares — quando um push chegava com o aplicativo ABERTO, e quando a tela
/// de notificações era visitada. Nenhum caminho de subida a lia. Um aplicativo
/// aberto do zero mostrava zero, sempre, mesmo com avisos esperando.
///
/// Estes testes moram em `widget/` de propósito. A `NF-4` já ensinou, com um
/// defeito real, que os fakes injetados não veem o que quebra na árvore de
/// verdade: eles atravessam o `GoRouter` real, o App Shell real e o cliente
/// HTTP real, e leem **o número desenhado no sino** — não o campo do estado.

// ---------------------------------------------------------------------------
// Cenário
// ---------------------------------------------------------------------------

/// O backend responde autenticado, com [naoLidas] avisos esperando.
void semear(FakeTransport transport, {int naoLidas = 0}) {
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
  transport.onJson('GET', '/time-clock/today', data: {});
  transport.onJson('POST', '/devices/register', data: {'device': {}});
  transport.onJson('POST', '/auth/login', data: {'token': 'token-do-login'});
  transport.onJson('POST', '/auth/logout');
  responderNotificacoes(transport, naoLidas: naoLidas);
}

/// Reescreve a resposta de `/notifications`. É assim que o teste simula o
/// backend tendo ganhado uma notificação nova enquanto o app estava fechado.
void responderNotificacoes(FakeTransport transport, {required int naoLidas}) {
  transport.onJson(
    'GET',
    '/notifications',
    data: {
      'items': List.generate(
        naoLidas,
        (i) => {
          'id': 'n$i',
          'type': 'SERVICE_ORDER_ASSIGNED',
          'title': 'Nova OS',
          'body': 'OS #10$i',
          'resourceType': 'ServiceOrder',
          'resourceId': 'os$i',
          'readAt': null,
          'createdAt': '2026-09-06T11:03:34.575Z',
        },
      ),
      'nextCursor': null,
      'unreadCount': naoLidas,
    },
  );
}

/// Avança em quadros, sem `pumpAndSettle`.
///
/// A tela de login mantém um indicador girando, e `pumpAndSettle` diante de
/// animação infinita nunca assenta: espera o prazo inteiro e mata o teste sem
/// dizer por quê.
Future<void> assentar(WidgetTester tester) async {
  for (var i = 0; i < 25; i++) {
    await tester.pump(const Duration(milliseconds: 60));
  }
}

/// O número DESENHADO no sino. Zero quando o badge não aparece.
///
/// Lê o widget, e não o estado: é o número que o técnico enxerga que estava
/// errado no piloto, e um teste sobre o campo do controlador passaria sem
/// provar que ele chegou à tela.
int badgeDoSino(WidgetTester tester) {
  final sino = find.byKey(const Key('notifications-bell'));
  expect(sino, findsOneWidget, reason: 'o sino não está na tela');
  final badge = tester.widget<Badge>(
    find.descendant(of: sino, matching: find.byType(Badge)),
  );
  if (badge.isLabelVisible != true) return 0;
  return int.parse((badge.label! as Text).data!);
}

IncomingPush avisoDeOs(String id) => IncomingPush(
  data: {
    'type': 'SERVICE_ORDER_ASSIGNED',
    'resourceType': 'ServiceOrder',
    'resourceId': id,
  },
  messageId: 'msg-$id',
);

({Harness harness, FakePushService push}) cenario({int naoLidas = 0}) {
  final harness = Harness();
  semear(harness.transport, naoLidas: naoLidas);
  return (
    harness: harness,
    push: FakePushService(status: PushPermissionStatus.authorized),
  );
}

/// Sobe o aplicativo com sessão JÁ guardada — o cold start de verdade.
///
/// O técnico do piloto não digita a senha ao abrir o aplicativo pela manhã:
/// ele tem token no cofre e o `bootstrap()` o valida. Testar só o caminho do
/// login mediria a metade errada.
Future<ProviderContainer> abrirComSessao(
  WidgetTester tester,
  Harness harness,
  FakePushService push,
) async {
  harness.store.token = 'token-guardado';
  final container = await harness.pumpApp(
    tester,
    extraOverrides: [fieldPushServiceProvider.overrideWithValue(push)],
  );
  await assentar(tester);
  return container;
}

int lidasDeNotificacoes(FakeTransport transport) => transport.requests
    .where((r) => r.method == 'GET' && r.path == '/notifications')
    .length;

void main() {
  setUp(() {
    // Sem o duplo, `SharedPreferences.getInstance()` não lança: ele nunca
    // responde, e a oferta de permissão fica pendurada antes de decidir.
    SharedPreferences.setMockInitialValues({});
  });

  group('NF5-BELL-01 · primeiro plano', () {
    testWidgets('push recebido com o app aberto atualiza o sino', (
      tester,
    ) async {
      final c = cenario();
      await abrirComSessao(tester, c.harness, c.push);
      expect(badgeDoSino(tester), 0);

      // O backend ganhou o aviso; o push apenas anuncia que algo mudou.
      responderNotificacoes(c.harness.transport, naoLidas: 1);
      c.push.receberEmPrimeiroPlano(avisoDeOs('os-7'));
      await assentar(tester);

      expect(badgeDoSino(tester), 1);
      c.push.fechar();
    });
  });

  group('NF5-BELL-02 · encerrado, aberto pelo aviso', () {
    testWidgets('o sino atualiza depois do bootstrap', (tester) async {
      /*
        O caminho exato do piloto: aplicativo ENCERRADO, push entregue, toque
        na notificação nativa. O destino chega por `getInitialMessage()`,
        antes de existir sessão — o bootstrap ainda vai acontecer.
      */
      final c = cenario(naoLidas: 2);
      c.push.mensagemInicial = avisoDeOs('os-7');

      await abrirComSessao(tester, c.harness, c.push);

      // Navegou para a OS, então o sino do detalhe não está em cena: a
      // afirmação sobre a tela é feita ao voltar para uma superfície do shell.
      c.harness.goTo('/inicio');
      await assentar(tester);

      expect(badgeDoSino(tester), 2);
      expect(c.push.initialMessageCalls, 1);
      c.push.fechar();
    });
  });

  group('NF5-BELL-03 · segundo plano, tocado', () {
    testWidgets('o toque em segundo plano atualiza o sino', (tester) async {
      final c = cenario();
      await abrirComSessao(tester, c.harness, c.push);
      expect(badgeDoSino(tester), 0);

      responderNotificacoes(c.harness.transport, naoLidas: 3);
      c.push.tocar(avisoDeOs('os-9'));
      await assentar(tester);

      c.harness.goTo('/inicio');
      await assentar(tester);

      expect(badgeDoSino(tester), 3);
      c.push.fechar();
    });
  });

  group('NF5-BELL-04 · abertura normal, sem push nenhum', () {
    testWidgets('consulta o backend e mostra a contagem certa', (tester) async {
      /*
        Ninguém tocou em nada e nenhum callback do Firebase disparou. É o caso
        que mais importa em campo: num aparelho sem Google Play o provedor
        nunca fala, e o sino não pode depender dele para dizer a verdade.
      */
      final c = cenario(naoLidas: 4);
      await abrirComSessao(tester, c.harness, c.push);

      expect(badgeDoSino(tester), 4);
      expect(lidasDeNotificacoes(c.harness.transport), 1);
      c.push.fechar();
    });
  });

  group('NF5-BELL-05 · aviso anterior à subida', () {
    testWidgets('contagem certa sem callback de push algum', (tester) async {
      final c = cenario(naoLidas: 5);
      // Nada de mensagem inicial, nada de toque, nada em primeiro plano.
      c.push.mensagemInicial = null;

      await abrirComSessao(tester, c.harness, c.push);

      expect(badgeDoSino(tester), 5);
      expect(c.push.initialMessageCalls, 1, reason: 'consultou e não havia');
      c.push.fechar();
    });

    testWidgets('vale também para quem entra pelo formulário', (tester) async {
      final c = cenario(naoLidas: 5);
      await c.harness.pumpApp(
        tester,
        extraOverrides: [fieldPushServiceProvider.overrideWithValue(c.push)],
      );
      await assentar(tester);
      expect(find.byKey(const Key('login-submit')), findsOneWidget);

      await tester.enterText(
        find.byKey(const Key('login-email')),
        'tech@alfa.test',
      );
      await tester.enterText(
        find.byKey(const Key('login-password')),
        'segredo',
      );
      await tester.tap(find.byKey(const Key('login-submit')));
      await assentar(tester);

      expect(badgeDoSino(tester), 5);
      c.push.fechar();
    });
  });

  group('NF5-BELL-06 · o backend é a autoridade', () {
    testWidgets('o push NÃO soma; a contagem vem da releitura', (tester) async {
      /*
        A prova precisa ser um caso em que somar e reler discordam. O backend
        responde 9 — porque outra pessoa marcou avisos como lidos noutro
        aparelho, ou porque o worker entregou dois eventos e um já fora
        lido. Um `count++` mostraria 8; a releitura mostra 9.
      */
      final c = cenario(naoLidas: 7);
      await abrirComSessao(tester, c.harness, c.push);
      expect(badgeDoSino(tester), 7);

      responderNotificacoes(c.harness.transport, naoLidas: 9);
      c.push.receberEmPrimeiroPlano(avisoDeOs('os-1'));
      await assentar(tester);

      expect(badgeDoSino(tester), 9);
      c.push.fechar();
    });

    testWidgets('quando o backend DIMINUI, o sino diminui junto', (
      tester,
    ) async {
      final c = cenario(naoLidas: 6);
      await abrirComSessao(tester, c.harness, c.push);
      expect(badgeDoSino(tester), 6);

      // Lidas noutro aparelho. Um contador local jamais desceria.
      responderNotificacoes(c.harness.transport, naoLidas: 0);
      c.push.receberEmPrimeiroPlano(avisoDeOs('os-1'));
      await assentar(tester);

      expect(badgeDoSino(tester), 0);
      c.push.fechar();
    });
  });

  group('NF5-BELL-07 · reler não duplica', () {
    testWidgets('vários eventos seguidos não multiplicam a contagem', (
      tester,
    ) async {
      final c = cenario(naoLidas: 2);
      await abrirComSessao(tester, c.harness, c.push);
      expect(badgeDoSino(tester), 2);

      for (var i = 0; i < 4; i++) {
        c.push.receberEmPrimeiroPlano(avisoDeOs('os-$i'));
        await assentar(tester);
      }

      expect(badgeDoSino(tester), 2);
      c.push.fechar();
    });

    testWidgets('subida com toque relê no máximo uma vez por caminho', (
      tester,
    ) async {
      /*
        Na subida por toque existem dois gatilhos — a sessão virando
        `authenticated` e o próprio toque —, e mesmo assim a leitura é UMA.

        O número foi medido, não presumido. `getInitialMessage()` resolve por
        microtask, enquanto o `/me` do bootstrap depende de uma volta de rede:
        quando o toque chega, a sessão ainda está em `bootstrapping`, o destino
        fica pendente e `handleTap` sai antes de reler. Quem relê é o gatilho
        de fase, sozinho.

        A afirmação é EXATA de propósito. Um `lessThanOrEqualTo(2)` toleraria a
        segunda requisição, que é custo real para quem está em borda de sinal —
        e um teste que tolera o desfecho ruim documenta o defeito como
        esperado.
      */
      final c = cenario(naoLidas: 2);
      c.push.mensagemInicial = avisoDeOs('os-7');
      await abrirComSessao(tester, c.harness, c.push);

      expect(lidasDeNotificacoes(c.harness.transport), 1);
      c.harness.goTo('/inicio');
      await assentar(tester);
      expect(badgeDoSino(tester), 2);
      c.push.fechar();
    });
  });

  group('NF5-BELL-08 · payload inválido', () {
    testWidgets('não mexe na contagem e não navega', (tester) async {
      final c = cenario(naoLidas: 1);
      await abrirComSessao(tester, c.harness, c.push);
      expect(badgeDoSino(tester), 1);
      final antes = lidasDeNotificacoes(c.harness.transport);

      /*
        O backend passaria a dizer 99 — mas nenhum destes payloads é
        reconhecido, então nenhuma releitura pode acontecer por causa deles.

        Cada um erra em UM campo só, e isso é deliberado: um payload errado em
        três campos passaria neste teste mesmo com a allowlist relaxada em dois
        deles. É a versão do teste que sobrevive a uma sabotagem por campo.
      */
      responderNotificacoes(c.harness.transport, naoLidas: 99);
      const somenteOTipoErrado = IncomingPush(
        data: {
          'type': 'PROMOCAO',
          'resourceType': 'ServiceOrder',
          'resourceId': 'os-7',
        },
      );
      const somenteORecursoErrado = IncomingPush(
        data: {
          'type': 'SERVICE_ORDER_ASSIGNED',
          'resourceType': 'Cupom',
          'resourceId': 'os-7',
        },
      );
      const somenteOIdErrado = IncomingPush(
        data: {
          'type': 'SERVICE_ORDER_ASSIGNED',
          'resourceType': 'ServiceOrder',
          'resourceId': '../../admin',
        },
      );

      for (final ruim in [
        somenteOTipoErrado,
        somenteORecursoErrado,
        somenteOIdErrado,
      ]) {
        c.push.tocar(ruim);
        c.push.receberEmPrimeiroPlano(ruim);
        await assentar(tester);
      }

      expect(badgeDoSino(tester), 1, reason: 'contagem inalterada');
      expect(lidasDeNotificacoes(c.harness.transport), antes);
      c.push.fechar();
    });
  });

  group('NF5-BELL-09 · a contagem morre com a sessão', () {
    testWidgets('sair zera o estado de quem saiu', (tester) async {
      /*
        Achado desta fase, e não do enunciado: nada invalidava o estado de
        notificações no logout. O técnico seguinte no mesmo aparelho entrava e
        o sino trazia o número do anterior até a releitura responder — e um
        toque nesse intervalo abriria a LISTA do anterior, com número de OS e
        nome de cliente na tela.
      */
      final c = cenario(naoLidas: 5);
      final container = await abrirComSessao(tester, c.harness, c.push);
      expect(badgeDoSino(tester), 5);

      /*
        `unawaited`, e não `await`. O logout fala com o transporte falso, que
        só responde quando o teste BOMBEIA — esperar por ele antes de bombear
        trava os dois lados. Quem avança o tempo é `assentar`.
      */
      unawaited(container.read(sessionControllerProvider.notifier).logout());
      await assentar(tester);

      expect(
        container.read(notificationsControllerProvider).unreadCount,
        0,
        reason: 'o estado do técnico anterior sobreviveu ao logout',
      );
      expect(
        container.read(notificationsControllerProvider).items,
        isEmpty,
        reason: 'a lista do técnico anterior sobreviveu ao logout',
      );
      c.push.fechar();
    });
  });
}
