import 'package:alfaos_field/core/errors/field_error.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_transport.dart';

/// O cliente HTTP: autenticação, contrato de erro e fim de sessão.
///
/// Estes testes exercitam o cliente REAL contra um transporte falso. O que eles
/// protegem é o que o aplicativo não pode errar em campo: mandar o Bearer,
/// traduzir o `code` do servidor e não entrar em laço com um token morto.
void main() {
  group('autenticação na requisição', () {
    test('manda o token como Bearer, e só no header', () async {
      final t = buildTestClient();
      await t.store.writeToken('token-de-teste-123');
      t.transport.onJson('GET', '/me', data: {'user': {}});

      await t.client.get('/me');

      final request = t.transport.requestFor('GET', '/me');
      expect(request.headers['Authorization'], 'Bearer token-de-teste-123');
      // Nunca em query string: a URL entra em log de servidor, histórico e
      // Referer.
      expect(request.uri.query, isNot(contains('token-de-teste-123')));
      expect(request.uri.toString(), isNot(contains('token-de-teste-123')));
    });

    test('rota não autenticada não leva o header', () async {
      final t = buildTestClient();
      await t.store.writeToken('token-de-teste-123');
      t.transport.onJson('POST', '/auth/login', data: {'token': 'novo'});

      await t.client.post('/auth/login', authenticated: false, body: {});

      expect(
        t.transport.requestFor('POST', '/auth/login').headers['Authorization'],
        isNull,
      );
    });

    test('Idempotency-Key viaja quando informada', () async {
      final t = buildTestClient();
      t.transport.onJson('POST', '/service-orders/os-1/start');

      await t.client.post(
        '/service-orders/os-1/start',
        idempotencyKey: 'start-abc-123',
        body: {'expectedVersion': 1},
      );

      expect(
        t.transport
            .requestFor('POST', '/service-orders/os-1/start')
            .headers['Idempotency-Key'],
        'start-abc-123',
      );
    });
  });

  group('contrato de erro', () {
    test('traduz cada código do catálogo', () async {
      final casos = <String, (int, FieldErrorCode)>{
        'UNAUTHENTICATED': (401, FieldErrorCode.unauthenticated),
        'FORBIDDEN': (403, FieldErrorCode.forbidden),
        'NOT_FOUND': (404, FieldErrorCode.notFound),
        'CONFLICT': (409, FieldErrorCode.conflict),
        'IDEMPOTENCY_CONFLICT': (409, FieldErrorCode.idempotencyConflict),
        'RATE_LIMITED': (429, FieldErrorCode.rateLimited),
        'VALIDATION_ERROR': (400, FieldErrorCode.validationError),
        'UPSTREAM_UNAVAILABLE': (503, FieldErrorCode.upstreamUnavailable),
        'DEVICE_REVOKED': (403, FieldErrorCode.deviceRevoked),
        'INTERNAL': (500, FieldErrorCode.internal),
      };

      for (final entry in casos.entries) {
        final t = buildTestClient();
        await t.store.writeToken('t');
        t.transport.onError(
          'GET',
          '/x',
          status: entry.value.$1,
          code: entry.key,
        );

        await expectLater(
          t.client.get('/x'),
          throwsA(
            isA<FieldException>().having(
              (e) => e.code,
              entry.key,
              entry.value.$2,
            ),
          ),
        );
      }
    });

    test('código desconhecido não estoura — cai em unknown', () async {
      final t = buildTestClient();
      await t.store.writeToken('t');
      t.transport.onError(
        'GET',
        '/x',
        status: 418,
        code: 'CODIGO_DO_FUTURO',
        message: 'algo novo',
      );

      // Um APK antigo diante de um código novo precisa continuar utilizável.
      await expectLater(
        t.client.get('/x'),
        throwsA(
          isA<FieldException>()
              .having((e) => e.code, 'code', FieldErrorCode.unknown)
              .having((e) => e.message, 'message', 'algo novo'),
        ),
      );
    });

    test('retryable e conflict vêm do servidor, não do status', () async {
      final t = buildTestClient();
      await t.store.writeToken('t');
      t.transport.onError(
        'POST',
        '/x',
        status: 409,
        code: 'CONFLICT',
        conflict: true,
      );

      await expectLater(
        t.client.post('/x'),
        throwsA(
          isA<FieldException>()
              .having((e) => e.conflict, 'conflict', isTrue)
              .having((e) => e.retryable, 'retryable', isFalse),
        ),
      );
    });

    test('falha de rede vira network, não internal', () async {
      final t = buildTestClient();
      t.transport.offline = true;

      await expectLater(
        t.client.get('/me'),
        throwsA(
          isA<FieldException>()
              .having((e) => e.code, 'code', FieldErrorCode.network)
              .having((e) => e.retryable, 'retryable', isTrue),
        ),
      );
    });

    test('erro não vaza detalhe interno do servidor', () async {
      final t = buildTestClient();
      await t.store.writeToken('t');
      t.transport.onError('GET', '/x', status: 500, code: 'INTERNAL');

      try {
        await t.client.get('/x');
        fail('deveria ter lançado');
      } on FieldException catch (error) {
        final serial = '${error.message} ${error.toString()}';
        for (final proibido in ['Prisma', 'SELECT', 'at Object', 'stack']) {
          expect(serial, isNot(contains(proibido)));
        }
      }
    });
  });

  group('fim de sessão', () {
    test('401 limpa o token guardado e avisa uma vez', () async {
      var avisos = 0;
      final t = buildTestClient(onSessionEnded: () => avisos++);
      await t.store.writeToken('token-que-morreu');
      t.transport.onError('GET', '/me', status: 401, code: 'UNAUTHENTICATED');

      await expectLater(t.client.get('/me'), throwsA(isA<FieldException>()));

      expect(t.store.token, isNull);
      expect(avisos, 1);
    });

    test('DEVICE_REVOKED NÃO limpa o token', () async {
      var avisos = 0;
      final t = buildTestClient(onSessionEnded: () => avisos++);
      await t.store.writeToken('token-do-aparelho-revogado');
      t.transport.onError('GET', '/me', status: 403, code: 'DEVICE_REVOKED');

      await expectLater(t.client.get('/me'), throwsA(isA<FieldException>()));

      /*
        Revogação também encerra a sessão, mas por outro caminho: apagar o token
        aqui levaria a pessoa para o login, onde ela digitaria a senha
        eternamente sem entender o motivo. A tela de revogado precisa aparecer.
      */
      expect(t.store.token, 'token-do-aparelho-revogado');
      expect(avisos, 0);
    });

    test('403 comum não encerra sessão', () async {
      var avisos = 0;
      final t = buildTestClient(onSessionEnded: () => avisos++);
      await t.store.writeToken('token-valido');
      t.transport.onError('POST', '/x', status: 403, code: 'FORBIDDEN');

      await expectLater(t.client.post('/x'), throwsA(isA<FieldException>()));

      expect(t.store.token, 'token-valido');
      expect(avisos, 0);
    });
  });

  test('2xx sem envelope é tratado como contrato quebrado', () async {
    final t = buildTestClient();
    await t.store.writeToken('t');
    t.transport.on(
      'GET',
      '/x',
      const FakeReply(status: 200, body: {'algo': 1}),
    );

    await expectLater(t.client.get('/x'), throwsA(isA<FieldException>()));
  });
}
