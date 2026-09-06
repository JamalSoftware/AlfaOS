import 'dart:async';

import 'package:alfaos_field/app/providers.dart';
import 'package:alfaos_field/core/push/field_push_service.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/fake_push_service.dart';
import '../support/fake_transport.dart';

import 'package:alfaos_field/app/push_permission_prompt.dart';
import 'package:alfaos_field/core/push/push_coordinator.dart';
import 'package:alfaos_field/core/push/push_prompt_memory.dart';
import 'package:alfaos_field/features/auth/state/session_controller.dart';

import '../support/harness.dart';

/// # A permissão de notificação, pelo caminho REAL (`NF-5`)
///
/// O piloto físico encontrou o defeito que nenhum teste desta trilha via: no
/// aparelho, depois de instalação limpa e login válido, **o pedido de permissão
/// nunca aparecia** — nem a folha do AlfaOS, nem o diálogo do Android.
///
/// A `NF-2` testou o `PushCoordinator` isolado, e ele sempre esteve certo. O
/// que faltava era um teste que atravessasse o wiring: login bem-sucedido → a
/// tela → o coordenador → a costura de `requestPermission`. É o que este
/// arquivo faz, e é por isso que ele mora em `widget/`.

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
  transport.onJson('POST', '/auth/logout');
}

/// Avança o tempo em quadros, SEM `pumpAndSettle`.
///
/// A tela de login mantém um indicador girando enquanto envia, e um
/// `pumpAndSettle` diante de uma animação infinita não assenta nunca: ele
/// espera os dez minutos do prazo padrão e mata o teste sem dizer por quê.
/// Bombear um número fixo de quadros é determinístico e suficiente.
Future<void> assentar(WidgetTester tester) async {
  for (var i = 0; i < 25; i++) {
    await tester.pump(const Duration(milliseconds: 60));
  }
}

/// Entra pelo formulário REAL — não pelo controlador.
///
/// A diferença é o teste inteiro: o defeito estava justamente entre o
/// `login()` retornar e a tela conseguir mostrar alguma coisa.
Future<void> entrar(WidgetTester tester) async {
  await tester.enterText(
    find.byKey(const Key('login-email')),
    'tech@alfa.test',
  );
  await tester.enterText(find.byKey(const Key('login-password')), 'segredo');
  await tester.tap(find.byKey(const Key('login-submit')));
  await assentar(tester);
}

({Harness harness, FakePushService push}) cenario({
  PushPermissionStatus permissao = PushPermissionStatus.notDetermined,
  PushPermissionStatus? aoPerguntar,
  String? token = 'fcm-token-de-teste',
  bool disponivel = true,
}) {
  final harness = Harness();
  seedAuthenticated(harness.transport);
  harness.transport.onJson(
    'POST',
    '/auth/login',
    data: {'token': 'token-do-login'},
  );
  final push = FakePushService(
    status: permissao,
    statusAoPerguntar: aoPerguntar,
    tokenValue: token,
    disponivel: disponivel,
  );
  return (harness: harness, push: push);
}

Future<void> montar(
  WidgetTester tester,
  Harness harness,
  FakePushService push,
) {
  return harness.pumpApp(
    tester,
    extraOverrides: [fieldPushServiceProvider.overrideWithValue(push)],
  );
}

void main() {
  setUp(() {
    /*
      A memória de 'já perguntamos' vive em SharedPreferences, e num teste de
      widget o canal nativo não existe: sem o duplo, `getInstance()` NÃO lança
      — ele simplesmente nunca responde, e `prepareAfterLogin()` fica pendurado
      antes de chegar à decisão que estes testes querem observar.
    */
    SharedPreferences.setMockInitialValues({});
  });

  group('NF5-P01 · instalação limpa + login', () {
    testWidgets('a folha de contexto é oferecida', (tester) async {
      final c = cenario();
      await montar(tester, c.harness, c.push);
      await assentar(tester);

      await entrar(tester);

      /*
        O defeito do piloto físico morava exatamente aqui.

        Quando a sessão vira `authenticated`, o `redirect` do GoRouter troca
        `/login` por `/inicio` e a `LoginScreen` é DESCARTADA. O código que
        oferecia a permissão rodava depois disso, no `State` da tela que já não
        existia, atrás de uma checagem de `mounted` — e simplesmente não
        acontecia. Nenhuma exceção, nenhum log: o técnico entrava e nunca era
        perguntado.
      */
      expect(find.byKey(const Key('push-permission-sheet')), findsOneWidget);
    });
  });

  group('NF5-P02 · ATIVAR', () {
    testWidgets('chama `requestPermission` uma vez', (tester) async {
      final c = cenario();
      await montar(tester, c.harness, c.push);
      await assentar(tester);
      await entrar(tester);

      await tester.tap(find.byKey(const Key('push-permission-enable')));
      await assentar(tester);

      expect(c.push.requestCalls, 1);
    });
  });

  group('NF5-P03 · AGORA NÃO', () {
    testWidgets('não chama `requestPermission`', (tester) async {
      final c = cenario();
      await montar(tester, c.harness, c.push);
      await assentar(tester);
      await entrar(tester);

      await tester.tap(find.byKey(const Key('push-permission-later')));
      await assentar(tester);

      expect(c.push.requestCalls, 0);
      expect(find.byKey(const Key('push-permission-sheet')), findsNothing);
    });
  });

  group('NF5-P04 · recusa do Android', () {
    testWidgets('o aplicativo continua, e o técnico está dentro', (
      tester,
    ) async {
      final c = cenario(aoPerguntar: PushPermissionStatus.denied);
      await montar(tester, c.harness, c.push);
      await assentar(tester);
      await entrar(tester);

      await tester.tap(find.byKey(const Key('push-permission-enable')));
      await assentar(tester);

      // Entrou, e a recusa não virou erro de login.
      expect(find.byKey(const Key('login-email')), findsNothing);
      expect(c.push.requestCalls, 1);
    });
  });

  group('NF5-P05 · permissão concedida', () {
    testWidgets('o ciclo de registro segue', (tester) async {
      final c = cenario(aoPerguntar: PushPermissionStatus.authorized);
      await montar(tester, c.harness, c.push);
      await assentar(tester);
      await entrar(tester);

      await tester.tap(find.byKey(const Key('push-permission-enable')));
      await assentar(tester);

      final comToken = c.harness.transport.requests
          .where((r) => r.path == '/devices/register')
          .map((r) => Map<String, dynamic>.from(r.data as Map))
          .where((b) => b.containsKey('pushToken'))
          .toList();

      expect(comToken, isNotEmpty);
      expect(comToken.first['pushToken'], 'fcm-token-de-teste');
    });
  });

  group('NF5-P06 · não duplica o pedido', () {
    testWidgets('a folha aparece uma vez só na tela', (tester) async {
      final c = cenario();
      await montar(tester, c.harness, c.push);
      await assentar(tester);
      await entrar(tester);
      await assentar(tester);

      expect(find.byKey(const Key('push-permission-sheet')), findsOneWidget);
    });

    test('a fase repetida NÃO abre uma segunda folha', () async {
      /*
        O guarda de reentrada só é exercido quando alguém CHAMA de novo, e a
        tela não faz isso: `ref.listen` dispara na MUDANÇA de fase. Sem este
        teste direto, remover o guarda não quebrava nada — foi o que a
        sabotagem `C` mostrou na primeira rodada.

        O caso real é uma reavaliação da fase com sessão já ativa: duas folhas
        empilhadas, e duas vezes o diálogo do Android.
      */
      final service = FakePushService();
      final coordinator = PushCoordinator(
        service: service,
        memory: InMemoryPushPromptMemory(),
        sink: (_) async {},
      );
      var aberturas = 0;
      final prompt = PushPermissionPrompt(
        coordinator: coordinator,
        settleDelay: Duration.zero,
        showSheet: () async {
          aberturas += 1;
          return true;
        },
      );

      await prompt.onSessionPhase(SessionPhase.authenticated);
      await prompt.onSessionPhase(SessionPhase.authenticated);
      await prompt.onSessionPhase(SessionPhase.authenticated);

      expect(aberturas, 1);
      expect(service.requestCalls, 1);
    });

    test('duas fases SIMULTÂNEAS abrem uma folha só', () async {
      /*
        O que a memória do coordenador NÃO cobre.

        Depois da primeira resposta ela já sabe que perguntamos, e por isso
        uma segunda chamada SEQUENCIAL é barrada por ela — foi o que a
        sabotagem `C` mostrou. A janela que sobra é a concorrente: duas
        chamadas entrando antes de a primeira terminar, quando a memória ainda
        não foi escrita. Duas folhas empilhadas, e dois diálogos do Android.
      */
      final service = FakePushService();
      final coordinator = PushCoordinator(
        service: service,
        memory: InMemoryPushPromptMemory(),
        sink: (_) async {},
      );
      var aberturas = 0;
      final prompt = PushPermissionPrompt(
        coordinator: coordinator,
        settleDelay: const Duration(milliseconds: 20),
        showSheet: () async {
          aberturas += 1;
          await Future<void>.delayed(const Duration(milliseconds: 20));
          return true;
        },
      );

      await Future.wait([
        prompt.onSessionPhase(SessionPhase.authenticated),
        prompt.onSessionPhase(SessionPhase.authenticated),
      ]);

      expect(aberturas, 1);
    });
  });
  group('NF5-P07 · sair e entrar de novo', () {
    testWidgets('não pergunta de novo, e não chama o sistema à toa', (
      tester,
    ) async {
      final c = cenario();
      await montar(tester, c.harness, c.push);
      await assentar(tester);
      await entrar(tester);

      await tester.tap(find.byKey(const Key('push-permission-later')));
      await assentar(tester);

      /*
        O logout NÃO é esperado aqui, e a razão é o relógio do teste.

        Ele depende da resposta do transporte falso, que só chega quando o
        teste bombeia um quadro. Esperar por ele antes de bombear trava o teste
        para sempre: o Dart fica parado no `await`, e o tempo — que só anda
        dentro do `pump` — nunca avança.
      */
      unawaited(
        c.harness.container.read(sessionControllerProvider.notifier).logout(),
      );
      await assentar(tester);
      await entrar(tester);

      /*
        "Agora não" é lembrado. Insistir a cada login ensina a tocar "não" sem
        ler — e no Android a segunda recusa faz o sistema parar de exibir o
        diálogo, gastando a permissão de vez.
      */
      expect(find.byKey(const Key('push-permission-sheet')), findsNothing);
      expect(c.push.requestCalls, 0);
    });
  });

  group('NF5-P08 · Firebase lento', () {
    testWidgets('o login não trava e a oportunidade não se perde', (
      tester,
    ) async {
      final c = cenario();
      // O provedor demora — é o comportamento real de um aparelho sem Google
      // Play respondendo devagar, e o que fazia o `await` travar a entrada.
      c.push.atrasoInicializacao = const Duration(milliseconds: 400);

      await montar(tester, c.harness, c.push);
      await assentar(tester);
      await entrar(tester);

      // Entrou (o login não ficou preso no indicador).
      expect(find.byKey(const Key('login-email')), findsNothing);

      // E a pergunta chegou, mesmo tendo demorado.
      await tester.pump(const Duration(milliseconds: 600));
      await tester.pumpAndSettle(const Duration(milliseconds: 50));
      expect(find.byKey(const Key('push-permission-sheet')), findsOneWidget);
    });
  });

  group('NF5-P09 · árvore ainda não pronta', () {
    test(
      'sem tela onde mostrar, a oferta é REAGENDADA e não marcada',
      () async {
        /*
        É a forma exata do defeito original: a oferta acontecia contra uma
        árvore que não existia mais, e desaparecia em silêncio. Aqui a
        primeira tentativa não encontra tela — o duplo devolve `null` — e o
        que se exige é que a pergunta CONTINUE pendente, sem marcar nada.
      */
        final service = FakePushService();
        final coordinator = PushCoordinator(
          service: service,
          memory: InMemoryPushPromptMemory(),
          sink: (_) async {},
        );
        var tentativas = 0;
        final prompt = PushPermissionPrompt(
          coordinator: coordinator,
          settleDelay: Duration.zero,
          showSheet: () async {
            tentativas += 1;
            return tentativas == 1 ? null : true;
          },
        );

        await prompt.onSessionPhase(SessionPhase.authenticated);
        expect(tentativas, 1);
        expect(service.requestCalls, 0, reason: 'não havia tela; nada a pedir');

        // Sessão nova: a pergunta volta, porque nunca foi respondida.
        await prompt.onSessionPhase(SessionPhase.unauthenticated);
        await prompt.onSessionPhase(SessionPhase.authenticated);

        expect(tentativas, 2);
        expect(service.requestCalls, 1);
      },
    );
  });
  group('NF5-P10 · permissão negada não registra token', () {
    testWidgets('nenhum `pushToken` vai ao servidor', (tester) async {
      final c = cenario(aoPerguntar: PushPermissionStatus.denied);
      await montar(tester, c.harness, c.push);
      await assentar(tester);
      await entrar(tester);

      await tester.tap(find.byKey(const Key('push-permission-enable')));
      await assentar(tester);

      final comToken = c.harness.transport.requests
          .where((r) => r.path == '/devices/register')
          .map((r) => Map<String, dynamic>.from(r.data as Map))
          .where((b) => b.containsKey('pushToken'))
          .toList();

      /*
        No Android o `getToken()` responde mesmo sem permissão: o token existe,
        e é a ENTREGA que o sistema descarta. Registrar assim faria
        `pushToken != null` significar "existe endereço" em vez de "dá para
        avisar esta pessoa".
      */
      expect(comToken, isEmpty);
    });
  });
}
