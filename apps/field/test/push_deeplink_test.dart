import 'dart:io';

import 'package:alfaos_field/app/push_navigator.dart';
import 'package:alfaos_field/core/push/field_push_service.dart';
import 'package:alfaos_field/core/push/push_coordinator.dart';
import 'package:alfaos_field/core/push/push_destination.dart';
import 'package:alfaos_field/core/push/push_prompt_memory.dart';
import 'package:alfaos_field/features/auth/state/session_controller.dart';
import 'package:alfaos_field/features/notifications/domain/app_notification.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_push_service.dart';

/// # Do toque à tela (`NF-4`)
///
/// Três coisas são provadas aqui, e a terceira é a que importa: o payload é
/// interpretado num lugar só, o toque respeita a sessão, e **push não é
/// autorização** — ele indica destino, e quem decide acesso continua sendo o
/// servidor, do outro lado da tela que abre.
///
/// Nenhum teste toca o Firebase.

const _osId = 'cmtmcq50u00b6vudsw9tgcio1';

Map<String, dynamic> payload({
  String type = PushDestination.serviceOrderAssigned,
  String? resourceType = PushDestination.serviceOrderResource,
  String? resourceId = _osId,
}) {
  return {
    'type': type,
    'resourceType': ?resourceType,
    'resourceId': ?resourceId,
  };
}

IncomingPush push({Map<String, dynamic>? data, String? id = 'msg-1'}) =>
    IncomingPush(data: data ?? payload(), messageId: id);

/// Roteador falso: guarda para onde mandaram ir, e onde estamos.
class RoteadorFalso {
  RoteadorFalso({this.atual = '/inicio'});

  String atual;
  final List<String> navegacoes = [];

  void push(String rota) {
    navegacoes.add(rota);
    atual = rota;
  }
}

typedef Cenario = ({
  FakePushService service,
  PushCoordinator coordinator,
  RoteadorFalso router,
  PushNavigator navigator,
  List<PushDestination> refresh,
});

Cenario montar({bool autenticado = true, String em = '/inicio'}) {
  final service = FakePushService();
  final coordinator = PushCoordinator(
    service: service,
    memory: InMemoryPushPromptMemory(),
    sink: (_) async {},
  );
  final router = RoteadorFalso(atual: em);
  final refresh = <PushDestination>[];
  var sessao = autenticado;

  return (
    service: service,
    coordinator: coordinator,
    router: router,
    refresh: refresh,
    navigator: PushNavigator(
      coordinator: coordinator,
      currentLocation: () => router.atual,
      navigate: router.push,
      sessionActive: () => sessao,
      onPushEvent: refresh.add,
    ),
  );
}

/// Cenário com controle sobre a sessão, para os testes que a mudam no meio.
({Cenario c, void Function(bool) definirSessao}) montarComSessao({
  bool autenticado = true,
  String em = '/inicio',
}) {
  final service = FakePushService();
  final coordinator = PushCoordinator(
    service: service,
    memory: InMemoryPushPromptMemory(),
    sink: (_) async {},
  );
  final router = RoteadorFalso(atual: em);
  final refresh = <PushDestination>[];
  var sessao = autenticado;

  final navigator = PushNavigator(
    coordinator: coordinator,
    currentLocation: () => router.atual,
    navigate: router.push,
    sessionActive: () => sessao,
    onPushEvent: refresh.add,
  );

  return (
    c: (
      service: service,
      coordinator: coordinator,
      router: router,
      navigator: navigator,
      refresh: refresh,
    ),
    definirSessao: (v) => sessao = v,
  );
}

Future<void> assentar() async {
  for (var i = 0; i < 3; i += 1) {
    await Future<void>.delayed(Duration.zero);
  }
}

void main() {
  // ---------------------------------------------------------------------
  // Parser
  // ---------------------------------------------------------------------

  group('NF4-01 · payload válido', () {
    test('vira a rota da OS', () {
      final destino = PushDestination.fromData(payload());

      expect(destino, isNotNull);
      expect(destino!.route, '/orders/$_osId');
      expect(destino.resourceId, _osId);
      expect(destino.eventType, PushDestination.serviceOrderAssigned);
    });
  });

  group('NF4-02 · tipo desconhecido', () {
    test('é ignorado, e não vira rota por parecer com uma', () {
      /*
        Allowlist, não roteador genérico. Se um `type` novo virasse destino
        sozinho, o payload passaria a ESCOLHER a tela — e o payload vem da
        rede.
      */
      for (final tipo in [
        'SERVICE_ORDER_COMPLETED',
        'TIME_CLOCK_REMINDER',
        'service_order_assigned',
        '',
      ]) {
        expect(
          PushDestination.fromData(payload(type: tipo)),
          isNull,
          reason: 'aceitou $tipo',
        );
      }
    });
  });

  group('NF4-03 · recurso desconhecido', () {
    test('é ignorado', () {
      for (final recurso in ['Customer', 'Workday', 'serviceorder', '']) {
        expect(
          PushDestination.fromData(payload(resourceType: recurso)),
          isNull,
          reason: 'aceitou $recurso',
        );
      }
    });
  });

  group('NF4-04 · identificador ausente', () {
    test('sem `resourceId` não há destino', () {
      expect(PushDestination.fromData(payload(resourceId: null)), isNull);
      expect(PushDestination.fromData(payload(resourceId: '')), isNull);
      expect(PushDestination.fromData(payload(resourceId: '   ')), isNull);
    });
  });

  group('NF4-05 · payload malformado', () {
    test('não estoura, seja o que for que venha', () {
      /*
        Isto roda na ABERTURA do aplicativo, ao consultar o toque que o abriu.
        Um parser que lança ali não deixa o aplicativo subir — e o técnico
        perde muito mais que a notificação.
      */
      expect(PushDestination.fromData(null), isNull);
      expect(PushDestination.fromData({}), isNull);
      expect(PushDestination.fromData({'type': 42}), isNull);
      expect(
        PushDestination.fromData({
          'type': PushDestination.serviceOrderAssigned,
          'resourceType': ['ServiceOrder'],
          'resourceId': {'id': 1},
        }),
        isNull,
      );
    });

    test('identificador com barra NÃO vira rota — injeção fechada', () {
      /*
        O ataque concreto: `resourceId` que escapa do segmento de caminho.
        `abc/execucao` montaria `/orders/abc/execucao` e abriria a EXECUÇÃO de
        uma OS a partir de um payload forjado.
      */
      for (final id in [
        'abc/execucao',
        '../settings',
        'abc?x=1',
        'abc#frag',
        'abc def',
        'abc%2Fexec',
        'a' * 65,
      ]) {
        expect(
          PushDestination.fromData(payload(resourceId: id)),
          isNull,
          reason: 'aceitou $id',
        );
      }
    });
  });

  // ---------------------------------------------------------------------
  // App fechado
  // ---------------------------------------------------------------------

  group('NF4-06 · aberto por um toque, com sessão', () {
    test('vai para a OS', () async {
      final c = montar();
      c.service.mensagemInicial = push();

      await c.navigator.start();
      await assentar();

      expect(c.router.navegacoes, ['/orders/$_osId']);
    });
  });

  group('NF4-07 · aberto por um toque, sem sessão', () {
    test('passa pelo login primeiro, e o destino ESPERA', () async {
      final c = montar(autenticado: false);
      c.service.mensagemInicial = push();

      await c.navigator.start();
      await assentar();

      /*
        Nenhuma navegação. Empurrar a rota aqui "funcionaria", porque o
        `redirect` do roteador mandaria para o login de qualquer jeito — mas
        funcionaria por acidente, e o destino se perderia no caminho.
      */
      expect(c.router.navegacoes, isEmpty);
      expect(c.navigator.pendingDestination, isNotNull);
    });
  });

  group('NF4-08 · login bem-sucedido', () {
    test('consome o destino que esperava', () async {
      final m = montarComSessao(autenticado: false);
      m.c.service.mensagemInicial = push();
      await m.c.navigator.start();
      await assentar();
      expect(m.c.router.navegacoes, isEmpty);

      m.definirSessao(true);
      m.c.navigator.onSessionPhase(SessionPhase.authenticated);

      expect(m.c.router.navegacoes, ['/orders/$_osId']);
      // E some depois de usado: uma segunda entrada não reabre a mesma OS.
      expect(m.c.navigator.pendingDestination, isNull);
      m.c.navigator.onSessionPhase(SessionPhase.authenticated);
      expect(m.c.router.navegacoes, hasLength(1));
    });
  });

  group('NF4-09 · login que falha', () {
    test('não abre destino nenhum, e o descarta', () async {
      final c = montar(autenticado: false);
      c.service.mensagemInicial = push();
      await c.navigator.start();
      await assentar();

      c.navigator.onSessionPhase(SessionPhase.unauthenticated);

      expect(c.router.navegacoes, isEmpty);
      /*
        Descartado, e isso é a regra do aparelho compartilhado: um destino
        guardado enquanto o técnico A tentava entrar não pode abrir na sessão
        do técnico B, que entrou no mesmo aparelho em seguida.
      */
      expect(c.navigator.pendingDestination, isNull);
    });

    test('aparelho revogado também descarta', () async {
      final c = montar(autenticado: false);
      c.service.mensagemInicial = push();
      await c.navigator.start();
      await assentar();

      c.navigator.onSessionPhase(SessionPhase.revoked);

      expect(c.navigator.pendingDestination, isNull);
    });
  });

  // ---------------------------------------------------------------------
  // App em segundo plano
  // ---------------------------------------------------------------------

  group('NF4-10 · toque com o app em segundo plano', () {
    test('abre a OS', () async {
      final c = montar();
      await c.navigator.start();

      c.service.tocar(push());
      await assentar();

      expect(c.router.navegacoes, ['/orders/$_osId']);
    });
  });

  group('NF4-11 · toque com sessão expirada', () {
    test('espera o fluxo de autenticação', () async {
      final m = montarComSessao(autenticado: false);
      await m.c.navigator.start();

      m.c.service.tocar(push());
      await assentar();

      expect(m.c.router.navegacoes, isEmpty);

      m.definirSessao(true);
      m.c.navigator.onSessionPhase(SessionPhase.authenticated);
      expect(m.c.router.navegacoes, ['/orders/$_osId']);
    });
  });

  group('NF4-12 · entrega repetida', () {
    test('o mesmo toque duas vezes navega UMA vez', () async {
      final c = montar();
      await c.navigator.start();

      final mesma = push(id: 'msg-repetida');
      c.service.tocar(mesma);
      await assentar();
      c.service.tocar(mesma);
      await assentar();

      expect(c.router.navegacoes, ['/orders/$_osId']);
    });

    test('a repetição é descartada mesmo estando LONGE da OS', () async {
      /*
        Este é o teste que prova a deduplicação, e o anterior não provava.

        Ali a segunda entrega chegava com o técnico já em `/orders/<id>`, e a
        guarda de "já estou lá" a descartaria sozinha — a asserção passava com
        a memória de mensagens removida. Aqui ele volta ao Início antes da
        repetição, então a única coisa capaz de segurá-la é o `messageId` já
        tratado.

        O caso real: `getInitialMessage()` e `onMessageOpenedApp` disparando
        pelo MESMO toque.
      */
      final c = montar();
      await c.navigator.start();

      final mesma = push(id: 'msg-repetida');
      c.service.tocar(mesma);
      await assentar();
      expect(c.router.navegacoes, hasLength(1));

      // O técnico sai da OS e volta ao Início.
      c.router.atual = '/inicio';

      c.service.tocar(mesma);
      await assentar();

      expect(c.router.navegacoes, hasLength(1));
    });

    test('a janela de repetição tem teto, e o id antigo sai dela', () async {
      /*
        A memória é uma janela contra repetição imediata, não um histórico:
        guardar tudo faria a lista crescer o dia inteiro para responder a uma
        pergunta que só importa por segundos. O preço é que o id mais antigo
        volta a ser aceito depois do teto — e é isso que se afirma aqui, para
        que o comportamento seja escolhido, e não descoberto.
      */
      final c = montar();
      await c.navigator.start();

      c.service.tocar(push(id: 'msg-antiga'));
      await assentar();
      c.router.atual = '/inicio';

      for (var i = 0; i < 32; i += 1) {
        c.service.tocar(
          push(
            id: 'enche-$i',
            data: payload(resourceId: 'x$i'),
          ),
        );
        await assentar();
        c.router.atual = '/inicio';
      }

      c.service.tocar(push(id: 'msg-antiga'));
      await assentar();

      expect(c.router.navegacoes.last, '/orders/$_osId');
    });

    test('mensagens diferentes para a MESMA OS também não empilham', () async {
      /*
        Segunda linha de defesa, independente do identificador: mesmo que a
        plataforma mande ids diferentes, ninguém empilha a tela onde a pessoa
        já está.
      */
      final c = montar();
      await c.navigator.start();

      c.service.tocar(push(id: 'msg-a'));
      await assentar();
      c.service.tocar(push(id: 'msg-b'));
      await assentar();

      expect(c.router.navegacoes, ['/orders/$_osId']);
    });
  });

  // ---------------------------------------------------------------------
  // App em primeiro plano
  // ---------------------------------------------------------------------

  group('NF4-13 · mensagem com o app aberto', () {
    test('NÃO navega — ninguém tocou em nada', () async {
      final c = montar(em: '/orders/outra-os/execucao');
      await c.navigator.start();

      c.service.receberEmPrimeiroPlano(push());
      await assentar();

      /*
        O técnico está no meio de uma execução. Trocar a tela debaixo da mão
        dele é a pior coisa que um aplicativo de campo pode fazer — e ele nem
        pediu: a mensagem chegou sozinha.
      */
      expect(c.router.navegacoes, isEmpty);
      expect(c.router.atual, '/orders/outra-os/execucao');
    });
  });

  group('NF4-14 · mensagem em primeiro plano atualiza estado', () {
    test('avisa quem precisa recarregar', () async {
      final c = montar();
      await c.navigator.start();

      c.service.receberEmPrimeiroPlano(push());
      await assentar();

      expect(c.refresh, hasLength(1));
      expect(c.refresh.single.route, '/orders/$_osId');
    });

    test('vários avisos seguidos não viram navegação nenhuma', () async {
      final c = montar();
      await c.navigator.start();

      for (var i = 0; i < 5; i += 1) {
        c.service.receberEmPrimeiroPlano(push(id: 'msg-$i'));
      }
      await assentar();

      expect(c.router.navegacoes, isEmpty);
      expect(c.refresh, hasLength(5));
    });
  });

  group('NF4-15 · payload inválido em primeiro plano', () {
    test('não atualiza nada e não navega', () async {
      final c = montar();
      await c.navigator.start();

      c.service.receberEmPrimeiroPlano(
        push(data: payload(type: 'DESCONHECIDO')),
      );
      c.service.receberEmPrimeiroPlano(push(data: {}));
      await assentar();

      expect(c.refresh, isEmpty);
      expect(c.router.navegacoes, isEmpty);
    });
  });

  // ---------------------------------------------------------------------
  // Autorização
  // ---------------------------------------------------------------------

  group('NF4-16 e NF4-17 · push indica, não autoriza', () {
    test('o app apenas ABRE a rota — não carrega dado do payload', () async {
      final c = montar();
      await c.navigator.start();

      c.service.tocar(push());
      await assentar();

      /*
        Toda a informação que sobrevive ao push é o identificador na URL. A
        tela de detalhe busca a OS pelo caminho autenticado de sempre, e é o
        servidor que responde 404 quando ela foi reatribuída (`NF4-16`) ou é de
        outra empresa (`NF4-17`). Os dois casos são provados contra o Postgres
        real em `src/tests/field-push-deeplink.test.ts`.
      */
      expect(c.router.navegacoes, ['/orders/$_osId']);
      expect(c.router.navegacoes.single, isNot(contains('company')));
    });

    test('o destino não carrega nada além do identificador', () {
      final destino = PushDestination.fromData({
        ...payload(),
        'customerName': 'Maria da Silva',
        'customerPhone': '(28) 99999-0001',
        'address': 'Rua das Flores, 84',
      })!;

      // O que o app usa é a rota, e ela só tem o id. Campos extras do payload
      // não viram estado do aplicativo em lugar nenhum.
      expect(destino.route, '/orders/$_osId');
      expect(destino.toString(), isNot(contains('Maria')));
      expect(destino.toString(), isNot(contains(_osId)));
    });
  });

  group('NF4-18 · o guarda do roteador não é contornado', () {
    test('sem sessão, `navigate` nunca é chamado', () async {
      final c = montar(autenticado: false);
      await c.navigator.start();

      c.service.tocar(push());
      c.service.mensagemInicial = push(id: 'outra');
      await assentar();

      expect(c.router.navegacoes, isEmpty);
    });

    test('o navegador não conhece `Navigator` nem `GoRouter`', () {
      /*
        Prova estrutural, e a mais importante da fase. O `redirect` do
        `GoRouter` é a ÚNICA autoridade de sessão do aplicativo; qualquer
        navegação que não passe por ele é uma segunda porta — e a segunda porta
        é a que ninguém lembra de trancar.
      */
      final fonte = File('lib/app/push_navigator.dart')
          .readAsStringSync()
          .replaceAll(RegExp(r'//.*'), '')
          .replaceAll(RegExp(r'/\*[\s\S]*?\*/'), '');

      expect(fonte, isNot(contains('Navigator.')));
      expect(fonte, isNot(contains('go_router')));
      expect(fonte, isNot(contains('GoRouter')));
    });
  });

  // ---------------------------------------------------------------------
  // Navegação
  // ---------------------------------------------------------------------

  group('NF4-19 · já está na OS do aviso', () {
    test('não empilha a mesma tela', () async {
      final c = montar(em: '/orders/$_osId');
      await c.navigator.start();

      c.service.tocar(push());
      await assentar();

      expect(c.router.navegacoes, isEmpty);
    });

    test('estar DENTRO da OS também basta', () async {
      /*
        Em `/orders/x/execucao`, o técnico está trabalhando naquela OS.
        Empurrá-lo para o detalhe dela por causa de um aviso sobre ela mesma
        interromperia o atendimento para mostrar menos informação.
      */
      final c = montar(em: '/orders/$_osId/execucao');
      await c.navigator.start();

      c.service.tocar(push());
      await assentar();

      expect(c.router.navegacoes, isEmpty);
    });
  });

  group('NF4-20 · aviso de OUTRA OS', () {
    test('navega para a outra', () async {
      const outra = 'cmtmcq50800b0vudsdrc66cij';
      final c = montar(em: '/orders/$_osId');
      await c.navigator.start();

      c.service.tocar(push(data: payload(resourceId: outra)));
      await assentar();

      expect(c.router.navegacoes, ['/orders/$outra']);
      expect(c.router.atual, '/orders/$outra');
    });
  });

  group('NF4-21 e NF4-22 · Voltar do Android', () {
    test('a regra da DQ-6 continua intacta', () {
      /*
        Regressão do que já existe, e não implementação nova. O detalhe aberto
        SEM pilha — que é exatamente o caso do deep link — manda o Voltar para
        `/orders`, e não deixa o pop escapar para o sistema fechando o
        aplicativo. Quem prova o comportamento é o teste de widget do detalhe;
        aqui se prova que a decisão continua escrita onde estava.
      */
      /*
        Os comentários saem ANTES da asserção, e isso não é zelo excessivo.

        Este codebase cita código literalmente em prosa — o próprio
        `order_detail_screen.dart` explica o `PopScope` num bloco de
        comentário. Um grep cru aceitaria a EXPLICAÇÃO no lugar da
        implementação: alguém removeria o `PopScope` mantendo o texto que o
        descreve, e este guarda continuaria verde sobre uma regressão da
        `DQ-6`.
      */
      String semComentarios(String caminho) =>
          File(caminho)
              .readAsStringSync()
              .replaceAll(RegExp(r'//.*'), '')
              .replaceAll(RegExp(r'/\*[\s\S]*?\*/'), '');

      final detalhe = semComentarios(
        'lib/features/orders/ui/order_detail_screen.dart',
      );

      expect(detalhe, contains('PopScope'));
      expect(detalhe, contains("go('/orders')"));
      expect(detalhe, contains('Navigator.of(context).canPop()'));

      // E a casca continua com a própria regra: gaveta fecha, aba volta ao
      // Início, e só o Início na raiz deixa o Android sair.
      final casca = semComentarios('lib/app/shell_back.dart');
      expect(casca, contains('closeDrawer'));
      expect(casca, contains('goHome'));
      expect(casca, contains('exitApp'));
    });
  });

  // ---------------------------------------------------------------------
  // Ciclo de vida
  // ---------------------------------------------------------------------

  group('NF4-23 · assinatura única', () {
    test('uma por stream, e um toque produz uma navegação', () async {
      final c = montar();
      await c.navigator.start();

      expect(c.service.aberturasVivas, 1);
      expect(c.service.primeiroPlanoVivas, 1);

      c.service.tocar(push());
      await assentar();

      expect(c.router.navegacoes, hasLength(1));
    });
  });

  group('NF4-24 · reiniciar não duplica ouvinte', () {
    test('três `start` deixam UMA assinatura viva por stream', () async {
      final c = montar();
      await c.navigator.start();
      await c.navigator.start();
      await c.navigator.start();

      /*
        A contagem é a asserção que importa, e não o número de navegações.

        Com ouvintes duplicados, a deduplicação do coordenador descarta o
        segundo evento e a checagem de "já estou lá" descarta o terceiro — o
        comportamento visível continua correto, e o vazamento segue vivo,
        acumulando uma assinatura por reinício até o aplicativo ficar
        perceptivelmente mais lento. Foi assim que a sabotagem `G` passou na
        primeira rodada.
      */
      expect(c.service.aberturasVivas, 1);
      expect(c.service.primeiroPlanoVivas, 1);

      c.service.tocar(push(id: 'msg-unica'));
      await assentar();

      expect(c.router.navegacoes, hasLength(1));
    });

    test('depois de `stop`, nada mais chega e nada fica assinado', () async {
      final c = montar();
      await c.navigator.start();
      await c.navigator.stop();

      expect(c.service.aberturasVivas, 0);
      expect(c.service.primeiroPlanoVivas, 0);

      c.service.tocar(push());
      c.service.receberEmPrimeiroPlano(push(id: 'fg'));
      await assentar();

      expect(c.router.navegacoes, isEmpty);
      expect(c.refresh, isEmpty);
    });
  });

  group('NF4-25 · falha do provedor', () {
    test('não impede o aplicativo de subir', () async {
      final c = montar();
      c.service.explodirInicial = true;

      // O que se prova é que `start()` COMPLETA. Uma exceção aqui subiria pelo
      // `addPostFrameCallback` e derrubaria a abertura.
      await c.navigator.start();
      await assentar();

      expect(c.router.navegacoes, isEmpty);
      expect(c.service.initialMessageCalls, 1);
    });
  });

  // ---------------------------------------------------------------------
  // A central de notificações usa o MESMO parser (§24)
  // ---------------------------------------------------------------------

  group('central de notificações', () {
    AppNotification aviso({
      String type = PushDestination.serviceOrderAssigned,
      String? resourceType = PushDestination.serviceOrderResource,
      String? resourceId = _osId,
    }) {
      return AppNotification.fromJson({
        'id': 'n1',
        'type': type,
        'title': 'Nova OS',
        'body': 'OS Nº 7',
        'resourceType': resourceType,
        'resourceId': resourceId,
        'createdAt': DateTime.now().toIso8601String(),
      });
    }

    test('o aviso válido leva à mesma rota do push', () {
      expect(aviso().destination?.route, '/orders/$_osId');
      expect(aviso().pointsToServiceOrder, isTrue);
    });

    test('identificador com barra deixou de virar rota', () {
      /*
        Endurecimento em profundidade, e a distinção importa para o registro.

        A tela exigia apenas `resourceId` não vazio, então um registro com
        barra montaria `/orders/abc/execucao`. Mas **não havia fonte
        alcançável**: existe uma única escrita de `Notification.resourceId` em
        produção (`src/lib/service-orders.ts`), sempre com o `id` da OS, que é
        um cuid. Não era vetor explorável — era um buraco esperando uma fonte.

        Passar pelo mesmo parser do push fecha os dois de uma vez, e o valor
        está justamente em não depender de a única fonte continuar sendo a
        única.
      */
      expect(aviso(resourceId: 'abc/execucao').destination, isNull);
      expect(aviso(resourceId: 'abc/execucao').pointsToServiceOrder, isFalse);
    });

    test('recurso que não é OS não leva a lugar nenhum', () {
      expect(aviso(resourceType: 'Customer').destination, isNull);
      expect(aviso(resourceType: null).destination, isNull);
    });
  });
}
