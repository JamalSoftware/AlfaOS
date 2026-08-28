import 'package:alfaos_field/app/providers.dart';
import 'package:alfaos_field/app/theme/theme_controller.dart';
import 'package:alfaos_field/features/auth/data/auth_repository.dart';
import 'package:alfaos_field/features/auth/state/session_controller.dart';
import 'package:alfaos_field/features/orders/state/order_detail_controller.dart';
import 'package:alfaos_field/features/orders/state/orders_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fake_transport.dart';

/// Jornada ponta a ponta contra o backend falso.
///
/// Login → contexto → fila → detalhe → iniciar, com os controladores e o
/// cliente HTTP reais. É o teste que prova que as peças conversam — e o único
/// que exercita o `SessionController`, que é onde a decisão de deslogar mora.
void main() {
  late FakeTransport transport;
  late FakeSessionStore store;
  late ProviderContainer container;

  ProviderContainer build() {
    transport = FakeTransport();
    store = FakeSessionStore();

    final c = ProviderContainer(
      overrides: [
        sessionStoreProvider.overrideWithValue(store),
        /*
          `overrideWith`, e não `overrideWithValue`.

          A primeira versão deste teste construía o cliente fora do container e
          o injetava pronto — e com isso pulava a fiação do
          `sessionSignalProvider`, que é justamente o que leva um 401 a derrubar
          a sessão. O teste passava a afirmar algo que não exercitava.

          Aqui a montagem é a MESMA da produção: o cliente lê o sinal do
          container e o dispara.
        */
        apiClientProvider.overrideWith((ref) {
          final signal = ref.watch(sessionSignalProvider);
          return buildTestClientWith(
            transport,
            store,
            onSessionEnded: signal.sessionEnded,
          );
        }),
        authRepositoryProvider.overrideWith(
          (ref) => AuthRepository(
            api: ref.watch(apiClientProvider),
            store: store,
            appVersionReader: () async => '0.1.0+1',
          ),
        ),
      ],
    );
    addTearDown(c.dispose);
    return c;
  }

  void seedHappyPath() {
    transport.onJson(
      'POST',
      '/auth/login',
      data: {
        'token': 'token-da-sessao',
        'device': {'id': 'd1'},
      },
    );
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
      'POST',
      '/devices/register',
      data: {
        'device': {'id': 'd1'},
      },
    );
    transport.onJson(
      'GET',
      '/service-orders',
      data: {
        'items': [
          {
            'id': 'os-1',
            'number': 7,
            'status': 'ASSIGNED',
            'priority': 'NORMAL',
            'type': 'Instalação',
            'subtype': null,
            'customerName': 'Maria da Silva',
            'district': 'Centro',
            'city': 'Guaçuí',
            'scheduledAt': null,
            'hasLocation': true,
            'updatedAt': '2026-08-27T10:00:00.000Z',
            'version': 3,
          },
        ],
        'nextCursor': null,
      },
    );
    transport.onJson(
      'GET',
      '/service-orders/os-1',
      data: {
        'serviceOrder': {
          'id': 'os-1',
          'number': 7,
          'status': 'ASSIGNED',
          'priority': 'NORMAL',
          'type': 'Instalação',
          'subtype': null,
          'description': 'Sem sinal.',
          'scheduledAt': null,
          'assignedAt': '2026-08-27T09:00:00.000Z',
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
          'connection': null,
          'execution': null,
          'diagnostic': null,
        },
      },
    );
    transport.onJson(
      'POST',
      '/service-orders/os-1/start',
      data: {
        'serviceOrder': {
          'id': 'os-1',
          'number': 7,
          'status': 'IN_PROGRESS',
          'priority': 'NORMAL',
          'startedAt': '2026-08-27T11:00:00.000Z',
          'updatedAt': '2026-08-27T11:00:00.000Z',
          'version': 4,
        },
        'execution': {
          'id': 'exec-1',
          'diagnosis': null,
          'workPerformed': null,
          'notes': null,
          'version': 0,
        },
      },
    );
  }

  test('login → me → fila → detalhe → iniciar', () async {
    container = build();
    seedHappyPath();

    await container
        .read(sessionControllerProvider.notifier)
        .login(email: 't@a.test', password: 'x');

    final session = container.read(sessionControllerProvider);
    expect(session.phase, SessionPhase.authenticated);
    expect(session.session!.userName, 'Tecnico Alfa');
    // O aparelho se registra depois de entrar.
    expect(transport.countOf('POST', '/devices/register'), 1);

    await container.read(ordersControllerProvider.notifier).load();
    final orders = container.read(ordersControllerProvider);
    expect(orders.items, hasLength(1));
    expect(orders.items.first.number, 7);

    /*
      A assinatura simula a TELA aberta.

      O provider do detalhe é `autoDispose` — para que a senha PPPoE revelada
      morra quando o técnico sai da OS. Sem um ouvinte, cada `read` recriaria o
      controlador e o teste mediria um estado recém-nascido, não o que a
      operação produziu.
    */
    final detail = orderDetailControllerProvider('os-1');
    final tela = container.listen(detail, (_, _) {});
    addTearDown(tela.close);

    await container.read(detail.notifier).load();
    expect(container.read(detail).order!.canStart, isTrue);

    await container.read(detail.notifier).start();
    final depois = container.read(detail).order!;
    expect(depois.isInProgress, isTrue);
    // A versão nova veio do RETORNO da mutação, não de uma releitura.
    expect(depois.version, 4);
    expect(transport.countOf('GET', '/service-orders/os-1'), 1);
  });

  test('401 no meio da sessão derruba para o login e limpa o token', () async {
    container = build();
    seedHappyPath();

    await container
        .read(sessionControllerProvider.notifier)
        .login(email: 't@a.test', password: 'x');
    expect(store.token, 'token-da-sessao');

    // O token foi revogado no servidor enquanto o app estava aberto.
    transport.onError(
      'GET',
      '/service-orders',
      status: 401,
      code: 'UNAUTHENTICATED',
    );
    await container.read(ordersControllerProvider.notifier).load();

    expect(store.token, isNull);
    expect(
      container.read(sessionControllerProvider).phase,
      SessionPhase.unauthenticated,
    );
  });

  test('sem rede na abertura NÃO apaga a credencial', () async {
    container = build();
    await store.writeToken('token-guardado');
    transport.offline = true;

    await container.read(sessionControllerProvider.notifier).bootstrap();

    /*
      Internet caindo não é motivo para deslogar alguém. Quem for revogado de
      verdade recebe 401 e cai em `unauthenticated`; aqui o app mostra estado de
      reconexão e guarda a credencial.
    */
    expect(
      container.read(sessionControllerProvider).phase,
      SessionPhase.offline,
    );
    expect(store.token, 'token-guardado');
  });

  test('aparelho revogado leva à tela própria, não ao login', () async {
    container = build();
    transport.onError(
      'POST',
      '/auth/login',
      status: 403,
      code: 'DEVICE_REVOKED',
      message: 'Este aparelho foi revogado.',
    );

    await expectLater(
      container
          .read(sessionControllerProvider.notifier)
          .login(email: 't@a.test', password: 'x'),
      throwsA(anything),
    );

    expect(
      container.read(sessionControllerProvider).phase,
      SessionPhase.revoked,
    );
  });

  test('conflito ao iniciar recarrega em vez de sobrescrever', () async {
    container = build();
    seedHappyPath();
    await container
        .read(sessionControllerProvider.notifier)
        .login(email: 't@a.test', password: 'x');

    // Mesma razão do teste acima: o detalhe é `autoDispose`, e a tela aberta é
    // o que o mantém vivo entre as chamadas.
    final detail = orderDetailControllerProvider('os-1');
    final tela = container.listen(detail, (_, _) {});
    addTearDown(tela.close);

    await container.read(detail.notifier).load();

    transport.onError(
      'POST',
      '/service-orders/os-1/start',
      status: 409,
      code: 'CONFLICT',
      conflict: true,
    );
    await container.read(detail.notifier).start();

    // Recarregou o detalhe; nunca reenviou o comando com a versão velha.
    expect(transport.countOf('GET', '/service-orders/os-1'), 2);
    expect(transport.countOf('POST', '/service-orders/os-1/start'), 1);
    expect(container.read(detail).order!.canStart, isTrue);
  });

  test('logout limpa a sessão e volta ao início', () async {
    container = build();
    seedHappyPath();
    transport.onJson('POST', '/auth/logout', data: {'loggedOut': true});

    await container
        .read(sessionControllerProvider.notifier)
        .login(email: 't@a.test', password: 'x');
    await container.read(sessionControllerProvider.notifier).logout();

    expect(store.token, isNull);
    expect(
      container.read(sessionControllerProvider).phase,
      SessionPhase.unauthenticated,
    );
  });

  group('preferência de tema', () {
    setUp(() => SharedPreferences.setMockInitialValues({}));

    test('padrão é o do sistema', () async {
      final controller = ThemeController();
      await controller.load();
      // O aparelho já sabe se é dia ou noite.
      expect(controller.state, ThemeMode.system);
    });

    test('a escolha persiste', () async {
      final controller = ThemeController();
      await controller.setMode(ThemeMode.dark);

      final outro = ThemeController();
      await outro.load();
      expect(outro.state, ThemeMode.dark);
    });

    test('valor estranho no armazenamento cai no padrão', () async {
      SharedPreferences.setMockInitialValues({
        'alfaos.field.theme_mode': 'algo-invalido',
      });
      final controller = ThemeController();
      await controller.load();
      // Allowlist fechada: um valor corrompido não quebra a construção do tema.
      expect(controller.state, ThemeMode.system);
    });
  });
}
