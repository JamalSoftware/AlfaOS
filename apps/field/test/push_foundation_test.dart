import 'dart:async';

import 'package:alfaos_field/core/push/field_push_service.dart';
import 'package:alfaos_field/core/push/push_coordinator.dart';
import 'package:alfaos_field/core/push/push_prompt_memory.dart';
import 'package:flutter_test/flutter_test.dart';

/// # A fundação de push do Field (`NF-2`)
///
/// Nenhum teste toca o Firebase. A costura `FieldPushService` existe para
/// isto: o que se prova aqui é **a decisão** — quando perguntar, o que fazer
/// com cada resposta, e o que acontece quando o provedor simplesmente não está
/// lá.
///
/// O token nunca aparece em asserção de log, e nenhum teste o imprime.

/// Duplo roteirizado do provedor.
class FakePushService implements FieldPushService {
  FakePushService({
    this.disponivel = true,
    this.status = PushPermissionStatus.notDetermined,
    this.tokenValue = 'tok-fake',
    this.statusAoPerguntar,
  });

  bool disponivel;
  PushPermissionStatus status;
  PushPermissionStatus? statusAoPerguntar;
  String? tokenValue;

  int initializeCalls = 0;
  int requestCalls = 0;
  int tokenCalls = 0;

  final _refresh = StreamController<String>.broadcast();

  /// Simula uma falha do provedor em qualquer chamada.
  bool explodir = false;

  @override
  Future<bool> initialize() async {
    initializeCalls += 1;
    if (explodir) throw StateError('firebase fora do ar');
    return disponivel;
  }

  @override
  Future<PushPermissionStatus> permissionStatus() async {
    if (explodir) throw StateError('firebase fora do ar');
    return disponivel ? status : PushPermissionStatus.unavailable;
  }

  @override
  Future<PushPermissionStatus> requestPermission() async {
    requestCalls += 1;
    if (explodir) throw StateError('firebase fora do ar');
    status = statusAoPerguntar ?? PushPermissionStatus.authorized;
    return status;
  }

  @override
  Future<String?> token() async {
    tokenCalls += 1;
    if (explodir) throw StateError('firebase fora do ar');
    return tokenValue;
  }

  @override
  Stream<String> get tokenRefresh => _refresh.stream;

  void rotacionar(String novo) => _refresh.add(novo);
  void fechar() => _refresh.close();
}

PushCoordinator coordenador(
  FakePushService service, {
  PushPromptMemory? memory,
}) {
  return PushCoordinator(
    service: service,
    memory: memory ?? InMemoryPushPromptMemory(),
  );
}

void main() {
  group('NF2-01 · inicialização', () {
    test('acontece uma vez, e não a cada consulta', () async {
      final real = FirebasePushService();

      /*
        Sem Firebase configurado — que é o estado do repositório — as duas
        chamadas devem devolver `false` e a segunda NÃO deve tentar de novo. Um
        provedor que reinicializasse a cada consulta pagaria a falha do SDK em
        todo login, em toda tela.
      */
      expect(await real.initialize(), isFalse);
      expect(await real.initialize(), isFalse);
      // E consultar estado depois disso continua sendo "indisponível".
      expect(await real.permissionStatus(), PushPermissionStatus.unavailable);
      expect(await real.token(), isNull);
    });
  });

  group('NF2-02 · permissão concedida', () {
    test('não pergunta de novo e já busca o token', () async {
      final service = FakePushService(status: PushPermissionStatus.authorized);

      final estado = await coordenador(service).prepareAfterLogin();

      expect(estado.status, PushPermissionStatus.authorized);
      expect(estado.shouldPrompt, isFalse);
      expect(estado.hasToken, isTrue);
      expect(service.requestCalls, 0);
    });
  });

  group('NF2-03 · permissão negada', () {
    test('não quebra nada, e NÃO volta a perguntar sozinho', () async {
      final service = FakePushService(status: PushPermissionStatus.denied);

      final estado = await coordenador(service).prepareAfterLogin();

      /*
        Negar é uma resposta legítima, não um erro. E no Android a decisão é
        lembrada: reapresentar a explicação a cada login pediria de novo o que
        a plataforma já não vai oferecer.
      */
      expect(estado.status, PushPermissionStatus.denied);
      expect(estado.shouldPrompt, isFalse);
      expect(estado.hasToken, isFalse);
      expect(service.requestCalls, 0);
    });
  });

  group('NF2-04 · obtenção do token', () {
    test('o token vem depois de a permissão ser concedida', () async {
      final service = FakePushService(tokenValue: 'tok-abc');
      final c = coordenador(service);

      final antes = await c.prepareAfterLogin();
      expect(antes.shouldPrompt, isTrue);
      expect(antes.hasToken, isFalse);

      final depois = await c.requestNow();
      expect(depois.status, PushPermissionStatus.authorized);
      expect(depois.token, 'tok-abc');
    });
  });

  group('NF2-05 · token nulo', () {
    test('permissão concedida sem token não quebra', () async {
      final service = FakePushService(tokenValue: null);

      final estado = await coordenador(service).requestNow();

      /*
        Acontece de verdade: o Google Play Services pode demorar a emitir, ou
        o aparelho pode não tê-lo. A permissão está concedida e o token virá
        pela rotação — tratar isto como falha esconderia o caso normal.
      */
      expect(estado.status, PushPermissionStatus.authorized);
      expect(estado.hasToken, isFalse);
      expect(estado.token, isNull);
    });
  });

  group('NF2-06 · rotação do token', () {
    test('o token novo é emitido para quem for registrá-lo', () async {
      final service = FakePushService();
      final c = coordenador(service);
      final recebidos = <String>[];
      final sub = c.tokenRefresh.listen(recebidos.add);

      service.rotacionar('tok-novo-1');
      service.rotacionar('tok-novo-2');
      await Future<void>.delayed(Duration.zero);

      /*
        Rotação acontece sozinha — reinstalação, limpeza de dados, decisão do
        FCM. Ignorá-la faria o aparelho parar de receber em silêncio, e ninguém
        descobriria até uma OS urgente não chegar.

        `NF-2` só EXPÕE o token novo. Quem o envia ao AlfaOS é o `NF-3`.
      */
      expect(recebidos, ['tok-novo-1', 'tok-novo-2']);
      await sub.cancel();
      service.fechar();
    });
  });

  group('NF2-07 · falha do Firebase', () {
    test('provedor indisponível não impede nada', () async {
      final service = FakePushService(disponivel: false);

      final estado = await coordenador(service).prepareAfterLogin();

      expect(estado.status, PushPermissionStatus.unavailable);
      expect(estado.shouldPrompt, isFalse);
      expect(estado.hasToken, isFalse);
    });

    test('`unavailable` é diferente de `denied`', () async {
      /*
        Um é ausência de infraestrutura, o outro é decisão da pessoa. Colapsar
        os dois faria a tela dizer "você recusou" para quem nunca foi
        perguntado — e é exatamente o estado do AlfaOS enquanto o projeto
        oficial do Firebase não existir.
      */
      final semFirebase = await coordenador(FakePushService(disponivel: false))
          .prepareAfterLogin();
      final recusado = await coordenador(
        FakePushService(status: PushPermissionStatus.denied),
      ).prepareAfterLogin();

      expect(semFirebase.status, PushPermissionStatus.unavailable);
      expect(recusado.status, PushPermissionStatus.denied);
      expect(semFirebase.status, isNot(recusado.status));
    });

    test(
      'o serviço real devolve stream vazia quando não há Firebase',
      () async {
        // Nem a rotação pode lançar: ela é escutada na subida.
        final real = FirebasePushService();
        expect(await real.tokenRefresh.isEmpty, isTrue);
      },
    );
  });

  group('NF2-08 · o token não vaza', () {
    test('o resultado carrega o token, e nada o imprime', () async {
      final service = FakePushService(tokenValue: 'tok-secreto');
      final estado = await coordenador(service).requestNow();

      /*
        O teste não pode provar ausência de `print` sozinho — isso é verificado
        por inspeção e pela prova de reversão `A`. O que ele fixa é o contrato:
        o token viaja no RESULTADO, para quem precisa dele, e não por log.
      */
      expect(estado.token, 'tok-secreto');
      expect(estado.toString(), isNot(contains('tok-secreto')));
    });
  });

  group('NF2-09 · nada acontece antes do login', () {
    test('o coordenador só é acionado por `prepareAfterLogin`', () async {
      final service = FakePushService();

      // Construir não inicializa, não consulta e não pergunta.
      coordenador(service);

      expect(service.initializeCalls, 0);
      expect(service.requestCalls, 0);
      expect(service.tokenCalls, 0);
    });
  });

  group('NF2-10 · depois do login, a oferta existe', () {
    test('estado indeterminado e nunca perguntado → oferece', () async {
      final service = FakePushService();

      final estado = await coordenador(service).prepareAfterLogin();

      expect(estado.shouldPrompt, isTrue);
      // Oferecer NÃO é perguntar: quem pergunta é a tela, com contexto.
      expect(service.requestCalls, 0);
    });
  });

  group('NF2-11 · "agora não"', () {
    test('o aplicativo continua, e a pergunta não se repete', () async {
      final service = FakePushService();
      final memory = InMemoryPushPromptMemory();
      final c = coordenador(service, memory: memory);

      expect((await c.prepareAfterLogin()).shouldPrompt, isTrue);
      await c.declineNow();

      final segundoLogin = await c.prepareAfterLogin();
      expect(segundoLogin.shouldPrompt, isFalse);
      expect(service.requestCalls, 0);
    });
  });

  group('NF2-12 · não insistir', () {
    test('depois de perguntar uma vez, não pergunta de novo', () async {
      final service = FakePushService(
        statusAoPerguntar: PushPermissionStatus.denied,
      );
      final memory = InMemoryPushPromptMemory();
      final c = coordenador(service, memory: memory);

      expect((await c.prepareAfterLogin()).shouldPrompt, isTrue);
      final resposta = await c.requestNow();
      expect(resposta.status, PushPermissionStatus.denied);

      // Três logins seguidos, e nenhuma pergunta nova.
      for (var i = 0; i < 3; i++) {
        expect((await c.prepareAfterLogin()).shouldPrompt, isFalse);
      }
      expect(service.requestCalls, 1);
    });

    test(
      'a marca é gravada mesmo se a pessoa dispensar sem escolher',
      () async {
        final memory = InMemoryPushPromptMemory();
        final c = coordenador(FakePushService(), memory: memory);

        await c.requestNow();

        // O que a marca registra é que a PERGUNTA foi feita.
        expect(await memory.alreadyAsked(), isTrue);
      },
    );
  });

  group('os três identificadores não se misturam', () {
    test('o push token não é o installationId nem o token de sessão', () {
      /*
        Prova de tipo e de superfície: `FieldPushService` **não** expõe
        installationId nem token de sessão, e o `PushPreparation` carrega
        apenas o push token. A confusão entre eles é o erro clássico da
        integração de push — um vira identidade, o outro vira endereço.
      */
      const preparo = PushPreparation(
        status: PushPermissionStatus.authorized,
        shouldPrompt: false,
        token: 'tok-fcm',
      );
      expect(preparo.token, 'tok-fcm');
      expect(preparo.hasToken, isTrue);

      const vazio = PushPreparation(
        status: PushPermissionStatus.unavailable,
        shouldPrompt: false,
      );
      expect(vazio.hasToken, isFalse);
    });
  });
}
