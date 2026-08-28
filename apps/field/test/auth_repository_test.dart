import 'package:alfaos_field/core/errors/field_error.dart';
import 'package:alfaos_field/features/auth/data/auth_repository.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_transport.dart';

/// Autenticação, registro de dispositivo e saída.
void main() {
  ({AuthRepository repo, FakeTransport transport, FakeSessionStore store})
  build() {
    final t = buildTestClient();
    return (
      repo: AuthRepository(
        api: t.client,
        store: t.store,
        appVersionReader: () async => '0.1.0+1',
      ),
      transport: t.transport,
      store: t.store,
    );
  }

  group('login', () {
    test('guarda o token no armazenamento seguro', () async {
      final t = build();
      t.transport.onJson(
        'POST',
        '/auth/login',
        data: {
          'token': 'token-novo-123',
          'device': {'id': 'd1'},
        },
      );

      await t.repo.login(email: 'tech@alfa.test', password: 'x');

      expect(t.store.token, 'token-novo-123');
      // E NUNCA no armazenamento comum, que é onde o `installationId` mora.
      expect(t.store.insecureWrites.values, isNot(contains('token-novo-123')));
    });

    test('o corpo não permite ao app escolher a própria autorização', () async {
      final t = build();
      t.transport.onJson('POST', '/auth/login', data: {'token': 'x'});

      await t.repo.login(email: '  TECH@alfa.test ', password: 'x');

      final body =
          t.transport.requestFor('POST', '/auth/login').data
              as Map<String, dynamic>;

      /*
        O app apenas TIRA ESPAÇO — o teclado do celular acrescenta um sozinho
        com frequência, e isso é problema de digitação.

        Quem normaliza maiúsculas é o servidor (`loginField` faz
        `toLowerCase().trim()`). Repetir a regra aqui criaria duas
        normalizações que um dia divergem, e a do cliente é a que ninguém
        lembraria de atualizar.
      */
      expect(body['email'], 'TECH@alfa.test');
      expect(body.keys, containsAll(['email', 'password', 'device']));
      for (final proibido in [
        'companyId',
        'userId',
        'technicianId',
        'role',
        'profile',
      ]) {
        expect(body.containsKey(proibido), isFalse, reason: proibido);
        expect(
          (body['device'] as Map).containsKey(proibido),
          isFalse,
          reason: 'device.$proibido',
        );
      }
    });

    test('o dispositivo se identifica por instalação, não por hardware', () async {
      final t = build();
      t.transport.onJson('POST', '/auth/login', data: {'token': 'x'});

      await t.repo.login(email: 'a@b.test', password: 'x');

      final device =
          (t.transport.requestFor('POST', '/auth/login').data
                  as Map<String, dynamic>)['device']
              as Map<String, dynamic>;

      expect(device['platform'], 'ANDROID');
      expect(device['installationId'], isNotEmpty);
      expect(device['appVersion'], '0.1.0+1');
      // Nada de IMEI, Android ID ou telefone: número é reciclado pela operadora
      // e pertence à pessoa, não à empresa.
      expect(device.containsKey('imei'), isFalse);
      expect(device.containsKey('androidId'), isFalse);
      expect(device.containsKey('phone'), isFalse);
    });

    test('credencial recusada não guarda token', () async {
      final t = build();
      t.transport.onError(
        'POST',
        '/auth/login',
        status: 401,
        code: 'UNAUTHENTICATED',
        message: 'Credenciais inválidas.',
      );

      await expectLater(
        t.repo.login(email: 'a@b.test', password: 'errada'),
        throwsA(isA<FieldException>()),
      );
      expect(t.store.token, isNull);
    });

    test('aparelho revogado propaga DEVICE_REVOKED', () async {
      final t = build();
      t.transport.onError(
        'POST',
        '/auth/login',
        status: 403,
        code: 'DEVICE_REVOKED',
        message: 'Este aparelho foi revogado.',
      );

      await expectLater(
        t.repo.login(email: 'a@b.test', password: 'x'),
        throwsA(
          isA<FieldException>().having(
            (e) => e.code,
            'code',
            FieldErrorCode.deviceRevoked,
          ),
        ),
      );
    });
  });

  test('/me devolve o contexto do técnico', () async {
    final t = build();
    await t.store.writeToken('t');
    t.transport.onJson(
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

    final session = await t.repo.me();
    expect(session.userName, 'Tecnico Alfa');
    expect(session.companyName, 'Alfa Telecom');
    expect(session.canStartOrder, isTrue);
  });

  test('registro de dispositivo manda só metadado', () async {
    final t = build();
    await t.store.writeToken('t');
    t.transport.onJson(
      'POST',
      '/devices/register',
      data: {
        'device': {'id': 'd1'},
      },
    );

    await t.repo.registerDevice();

    final body =
        t.transport.requestFor('POST', '/devices/register').data
            as Map<String, dynamic>;
    expect(body, {'appVersion': '0.1.0+1'});
  });

  group('logout', () {
    test('chama o servidor e limpa a sessão', () async {
      final t = build();
      await t.store.writeToken('token-vivo');
      t.transport.onJson('POST', '/auth/logout', data: {'loggedOut': true});

      await t.repo.logout();

      expect(t.transport.countOf('POST', '/auth/logout'), 1);
      expect(t.store.token, isNull);
    });

    test('sem rede, ainda assim limpa localmente', () async {
      final t = build();
      await t.store.writeToken('token-vivo');
      t.transport.offline = true;

      await t.repo.logout();

      /*
        Sair tem de funcionar offline.

        Insistir deixaria o token válido num aparelho de onde o técnico já quis
        sair — e o servidor tem prazo e revogação para cobrir o resto.
      */
      expect(t.store.token, isNull);
    });
  });

  test('installationId sobrevive ao logout', () async {
    final t = build();
    final antes = await t.store.installationId();
    await t.repo.logout();
    final depois = await t.store.installationId();

    // Ele identifica a INSTALAÇÃO, não a sessão. Recriá-lo a cada saída faria o
    // servidor acumular uma linha de dispositivo por login.
    expect(depois, antes);
  });
}
