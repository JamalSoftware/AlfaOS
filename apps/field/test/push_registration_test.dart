import 'dart:io';

import 'package:alfaos_field/core/logging/log.dart';
import 'package:alfaos_field/core/push/field_push_service.dart';
import 'package:alfaos_field/core/push/push_coordinator.dart';
import 'package:alfaos_field/core/push/push_prompt_memory.dart';
import 'package:alfaos_field/features/auth/data/auth_repository.dart';
import 'package:alfaos_field/features/auth/state/session_controller.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fake_push_service.dart';
import 'support/fake_transport.dart';

/// # O token de push chega ao AlfaOS (`NF-3`)
///
/// A `NF-2` obteve o token e o deixou sem destino. Aqui ele viaja até o
/// `MobileDevice`, e continua viajando quando o Firebase o rotaciona.
///
/// Os testes montam a pilha REAL do aplicativo — `SessionController`,
/// `PushCoordinator`, `AuthRepository` e o `FieldApiClient` de produção sobre
/// um transporte falso. É o que permite afirmar o que foi de fato enviado:
/// corpo, cabeçalho e ORDEM. Um duplo de repositório provaria apenas que o
/// duplo obedece.
///
/// Nenhum teste imprime o token.

const _tokenA = 'fcm-token-aparelho-A';
const _tokenB = 'fcm-token-aparelho-B';

typedef Cenario = ({
  FakeTransport transport,
  FakeSessionStore store,
  FakePushService push,
  PushCoordinator coordinator,
  AuthRepository repo,
  SessionController session,
});

Cenario montar({
  PushPermissionStatus permissao = PushPermissionStatus.authorized,
  String? token = _tokenA,
}) {
  final transport = FakeTransport();
  final store = FakeSessionStore();
  final api = buildTestClientWith(transport, store);
  final repo = AuthRepository(
    api: api,
    store: store,
    appVersionReader: () async => '0.1.0+1',
  );
  final push = FakePushService(status: permissao, tokenValue: token);
  final coordinator = PushCoordinator(
    service: push,
    memory: InMemoryPushPromptMemory(),
    // A MESMA ligação de `providers.dart`: uma função, não o repositório.
    sink: (t) => repo.registerDevice(pushToken: t),
  );
  return (
    transport: transport,
    store: store,
    push: push,
    coordinator: coordinator,
    repo: repo,
    session: SessionController(
      auth: repo,
      signal: SessionSignal(),
      push: coordinator,
    ),
  );
}

/// Prepara as respostas de um login bem-sucedido.
void rotasDeLogin(
  FakeTransport transport, {
  String sessao = 'sessao-A',
  int statusRegistro = 200,
  Duration atrasoRegistro = Duration.zero,
}) {
  transport.onJson('POST', '/auth/login', data: {'token': sessao});
  transport.onJson('GET', '/me', data: {'user': {}});
  transport.onJson('POST', '/auth/logout');
  if (statusRegistro == 200) {
    transport.onJson(
      'POST',
      '/devices/register',
      data: {'device': {}},
      delay: atrasoRegistro,
    );
  }
}

/// Os corpos enviados ao `/devices/register`.
List<Map<String, dynamic>> registros(FakeTransport t) => t.requests
    .where((r) => r.method == 'POST' && r.path == '/devices/register')
    .map((r) => Map<String, dynamic>.from(r.data as Map))
    .toList();

/// Só os que carregaram token de push.
List<String> tokensRegistrados(FakeTransport t) =>
    registros(t)
        .where((b) => b.containsKey('pushToken'))
        .map((b) => b['pushToken'] as String)
        .toList();

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('NF3-01 · login com token disponível', () {
    test('o token vai ao AlfaOS, autenticado', () async {
      final c = montar();
      rotasDeLogin(c.transport);

      await c.session.login(email: 'tech@alfa.test', password: 'x');
      await c.coordinator.settled();

      expect(tokensRegistrados(c.transport), [_tokenA]);

      // E foi com a credencial da sessão — nunca em query string.
      final envio = c.transport.requests.lastWhere(
        (r) => r.path == '/devices/register',
      );
      expect(envio.headers['Authorization'], 'Bearer sessao-A');
      expect(envio.uri.query, isEmpty);
    });
  });

  group('NF3-02 · token ainda indisponível', () {
    test(
      'não envia `pushToken: null`, que apagaria o que já funcionava',
      () async {
        final c = montar(token: null);
        rotasDeLogin(c.transport);

        await c.session.login(email: 'tech@alfa.test', password: 'x');
        await c.coordinator.settled();

        /*
        O registro de metadados do `NF-0` continua acontecendo — é ele que diz
        ao suporte qual APK está em campo. O que NÃO pode acontecer é a chave
        `pushToken` aparecer com `null`: o contrato do servidor lê isso como
        revogação, e o provedor devolve `null` por motivo banal (ainda não
        terminou de emitir).
      */
        expect(registros(c.transport), isNotEmpty);
        expect(tokensRegistrados(c.transport), isEmpty);
        for (final corpo in registros(c.transport)) {
          expect(corpo.containsKey('pushToken'), isFalse);
        }
      },
    );
  });

  group('NF3-03 · permissão negada', () {
    test('não registra endereço que o sistema vai descartar', () async {
      final c = montar(permissao: PushPermissionStatus.denied);
      rotasDeLogin(c.transport);

      await c.session.login(email: 'tech@alfa.test', password: 'x');
      await c.coordinator.settled();

      /*
        No Android o `getToken()` responde mesmo sem permissão. Registrar assim
        faria `pushToken != null` significar "existe endereço" em vez de "dá
        para avisar esta pessoa" — e a segunda é a pergunta que o worker faz.
      */
      expect(tokensRegistrados(c.transport), isEmpty);
    });
  });

  group('NF3-04 · rotação com sessão ativa', () {
    test('o token novo substitui o anterior', () async {
      final c = montar();
      rotasDeLogin(c.transport);
      await c.session.login(email: 'tech@alfa.test', password: 'x');
      await c.coordinator.settled();

      c.push.rotacionar(_tokenB);
      await c.coordinator.settled();

      expect(tokensRegistrados(c.transport), [_tokenA, _tokenB]);
    });
  });

  group('NF3-05 · idempotência', () {
    test('o mesmo token de novo não vira requisição', () async {
      final c = montar();
      rotasDeLogin(c.transport);
      await c.session.login(email: 'tech@alfa.test', password: 'x');
      await c.coordinator.settled();

      c.push.rotacionar(_tokenA);
      await c.coordinator.settled();
      c.push.rotacionar(_tokenA);
      await c.coordinator.settled();

      /*
        O aplicativo reenvia o mesmo token o tempo todo, e é o comportamento
        correto dele. Repetir a requisição não corromperia nada no servidor —
        que também é idempotente —, mas encheria a trilha de auditoria do
        aparelho de linhas iguais, no volume exato em que ela deixaria de ser
        lida.
      */
      expect(tokensRegistrados(c.transport), [_tokenA]);
    });
  });

  group('NF3-06 · rotação antes de haver sessão', () {
    test('nenhuma requisição sem credencial', () async {
      final c = montar();
      rotasDeLogin(c.transport);

      // Construir o coordenador não assina nada.
      expect(c.push.assinantesVivos, 0);

      c.push.rotacionar(_tokenB);
      await Future<void>.delayed(Duration.zero);
      await c.coordinator.settled();

      expect(c.transport.countOf('POST', '/devices/register'), 0);
    });
  });

  group('NF3-07 · falha de rede', () {
    test('o técnico continua dentro do aplicativo', () async {
      final c = montar();
      rotasDeLogin(c.transport);
      c.transport.onError(
        'POST',
        '/devices/register',
        status: 500,
        code: 'INTERNAL',
        retryable: true,
      );

      await c.session.login(email: 'tech@alfa.test', password: 'x');
      await c.coordinator.settled();

      expect(c.session.state.phase, SessionPhase.authenticated);
      expect(tokensRegistrados(c.transport), [_tokenA]);

      /*
        E a falha NÃO marcou o token como registrado.

        A prova é reenviar o MESMO token: se o envio malsucedido tivesse
        contado, a proteção de idempotência engoliria a segunda tentativa e o
        aparelho ficaria para sempre sem destino no servidor — sem erro
        nenhum, e sem ninguém para notar.
      */
      c.transport.onJson('POST', '/devices/register', data: {'device': {}});
      c.push.rotacionar(_tokenA);
      await c.coordinator.settled();
      expect(tokensRegistrados(c.transport), [_tokenA, _tokenA]);
    });

    test('ausência total de rede não lança', () async {
      final c = montar();
      rotasDeLogin(c.transport);
      await c.session.login(email: 'tech@alfa.test', password: 'x');
      await c.coordinator.settled();

      c.transport.offline = true;
      c.push.rotacionar(_tokenB);
      await c.coordinator.settled();

      expect(c.session.state.phase, SessionPhase.authenticated);
    });
  });

  group('NF3-08 · sessão recusada', () {
    test('401 não vira laço de retentativa', () async {
      final c = montar();
      rotasDeLogin(c.transport);
      c.transport.onError(
        'POST',
        '/devices/register',
        status: 401,
        code: 'UNAUTHENTICATED',
      );

      await c.session.login(email: 'tech@alfa.test', password: 'x');
      await c.coordinator.settled();
      await c.coordinator.settled();

      /*
        Uma tentativa, e para. Quem manda em sessão é o fluxo de autenticação;
        push insistindo com credencial recusada só produziria requisição inútil
        — e, num aparelho revogado, ruído em cima de uma decisão já tomada.
      */
      final antes = c.transport.countOf('POST', '/devices/register');
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(c.transport.countOf('POST', '/devices/register'), antes);
      expect(antes, lessThanOrEqualTo(2));
    });
  });

  group('NF3-09 · depois do logout', () {
    test('a rotação não é mais registrada', () async {
      final c = montar();
      rotasDeLogin(c.transport);
      await c.session.login(email: 'tech@alfa.test', password: 'x');
      await c.coordinator.settled();

      await c.session.logout();
      expect(c.push.assinantesVivos, 0);

      c.push.rotacionar(_tokenB);
      await Future<void>.delayed(Duration.zero);
      await c.coordinator.settled();

      expect(tokensRegistrados(c.transport), isNot(contains(_tokenB)));
    });
  });

  group('NF3-10 · corrida entre rotação e logout', () {
    test('o registro em voo termina ANTES de o servidor limpar', () async {
      final c = montar();
      rotasDeLogin(
        c.transport,
        atrasoRegistro: const Duration(milliseconds: 40),
      );
      await c.session.login(email: 'tech@alfa.test', password: 'x');
      await c.coordinator.settled();

      /*
        A janela perigosa é esta, e ela precisa ser FORÇADA: a requisição de
        registro já saiu e está esperando resposta quando o logout começa.

        Se a rotação nem tivesse chegado ao ouvinte, o desfecho seria outro —
        e também seguro: `stopSession` derruba a sessão antes, e o evento é
        simplesmente descartado (é o `NF3-09`). O que este teste cobre é o
        caso em que descartar já não é opção, porque a escrita está em curso.
      */
      c.push.rotacionar(_tokenB);
      await Future<void>.delayed(Duration.zero);
      await c.session.logout();

      /*
        A asserção é sobre CONCLUSÃO, não sobre despacho — e a diferença é o
        teste inteiro.

        A primeira versão comparava índices em `transport.requests`, que é
        preenchida no momento em que a requisição SAI. Como o teste despacha a
        rotação antes de chamar o logout, aquele índice já estava cravado: a
        asserção passava mesmo com `logout()` invertido para limpar o servidor
        primeiro. Um teste que documenta como coberta uma propriedade que ele
        não cobre é pior que não existir.

        A linha do tempo marca os dois momentos. O que precisa ser verdade é
        que o registro RESPONDEU antes de o logout sequer sair — senão o
        servidor limparia o `pushToken` e a resposta atrasada o gravaria de
        volta, deixando um aparelho de onde o técnico acabou de sair como
        destino de notificação, sem nada na tela mostrando isso.
      */
      final linha = c.transport.timeline;
      final registroConcluiu = linha.lastIndexOf('< POST /devices/register');
      final logoutSaiu = linha.indexOf('> POST /auth/logout');

      expect(registroConcluiu, greaterThanOrEqualTo(0));
      expect(logoutSaiu, greaterThanOrEqualTo(0));
      expect(registroConcluiu, lessThan(logoutSaiu));
      expect(tokensRegistrados(c.transport), contains(_tokenB));

      // E, encerrada a sessão, nada mais é registrado.
      c.push.rotacionar('fcm-token-tardio');
      await Future<void>.delayed(Duration.zero);
      await c.coordinator.settled();
      expect(
        tokensRegistrados(c.transport),
        isNot(contains('fcm-token-tardio')),
      );
    });

    test('espera TODOS os envios em voo, não só o mais recente', () async {
      final c = montar();
      rotasDeLogin(c.transport);
      await c.session.login(email: 'tech@alfa.test', password: 'x');
      await c.coordinator.settled();

      /*
        Dois envios sobrepostos, e o ANTIGO é o lento.

        A montagem é deliberada: se a espera do logout guardasse só o ÚLTIMO
        envio, ela terminaria junto com o rápido e devolveria o controle
        enquanto o lento ainda estava a caminho. O logout limparia o
        `pushToken` no servidor e a resposta órfã o gravaria de volta — a
        mesma reativação do §17, por outra porta.

        Com atrasos iguais o teste não discriminaria nada: o primeiro a sair
        seria o primeiro a voltar, e a órfã chegaria a tempo por coincidência.
      */
      c.transport.onJson(
        'POST',
        '/devices/register',
        data: {'device': {}},
        delay: const Duration(milliseconds: 60),
      );
      c.push.rotacionar(_tokenB);
      await Future<void>.delayed(Duration.zero);

      c.transport.onJson(
        'POST',
        '/devices/register',
        data: {'device': {}},
        delay: const Duration(milliseconds: 1),
      );
      c.push.rotacionar('fcm-token-terceiro');
      await Future<void>.delayed(Duration.zero);

      await c.session.logout();

      final linha = c.transport.timeline;
      final logoutSaiu = linha.indexOf('> POST /auth/logout');
      final ultimaConclusao = linha.lastIndexOf('< POST /devices/register');

      expect(logoutSaiu, greaterThanOrEqualTo(0));
      expect(ultimaConclusao, lessThan(logoutSaiu));
      expect(
        tokensRegistrados(c.transport),
        containsAll([_tokenB, 'fcm-token-terceiro']),
      );
    });

    test('o mesmo token em voo não vira duas requisições', () async {
      final c = montar();
      rotasDeLogin(
        c.transport,
        atrasoRegistro: const Duration(milliseconds: 30),
      );

      /*
        O caminho normal do primeiro login: `startSession` lê o token e o
        entrega, e o provedor emite a rotação com o MESMO token quase no mesmo
        instante. A deduplicação por último-registrado não alcança isso — ela
        só é escrita depois do sucesso, e nesse momento ainda é nula.
      */
      final abertura = c.coordinator.startSession();
      /*
        A espera aqui é obrigatória, e a primeira versão deste teste não a
        tinha — o que o tornava inútil.

        `startSession` cancela a assinatura anterior antes de assinar, e isso
        custa uma volta do laço. Emitindo antes disso, o `Stream.broadcast`
        DESCARTA o evento por não ter ouvinte: a sobreposição que o teste quer
        provar nunca acontecia, e ele passava com o guarda removido.
      */
      await Future<void>.delayed(Duration.zero);
      c.push.rotacionar(_tokenA);
      await abertura;
      await c.coordinator.settled();

      expect(tokensRegistrados(c.transport), [_tokenA]);
    });
  });

  group('NF3-11 · técnico A sai, técnico B entra', () {
    test('o mesmo token é registrado de novo, sob a sessão de B', () async {
      final c = montar();
      rotasDeLogin(c.transport, sessao: 'sessao-A');
      await c.session.login(email: 'a@alfa.test', password: 'x');
      await c.coordinator.settled();
      await c.session.logout();

      rotasDeLogin(c.transport, sessao: 'sessao-B');
      await c.session.login(email: 'b@alfa.test', password: 'x');
      await c.coordinator.settled();

      /*
        O token é da INSTALAÇÃO, não da pessoa: ele não muda quando o técnico
        troca. Se a memória de "já registrei" sobrevivesse ao logout, B nunca
        registraria — e o aparelho ficaria mudo para ele sem nenhum sinal.
      */
      final deB = c.transport.requests
          .where((r) => r.path == '/devices/register')
          .where((r) => r.headers['Authorization'] == 'Bearer sessao-B')
          .map((r) => Map<String, dynamic>.from(r.data as Map))
          .where((b) => b.containsKey('pushToken'))
          .toList();

      expect(deB, hasLength(1));
      expect(deB.single['pushToken'], _tokenA);
    });
  });

  group('NF3-12 · ciclo de vida do ouvinte', () {
    test('dois logins não deixam dois ouvintes', () async {
      final c = montar();
      rotasDeLogin(c.transport, sessao: 'sessao-A');
      await c.session.login(email: 'a@alfa.test', password: 'x');
      await c.coordinator.settled();
      await c.session.logout();
      rotasDeLogin(c.transport, sessao: 'sessao-B');
      await c.session.login(email: 'b@alfa.test', password: 'x');
      await c.coordinator.settled();

      expect(c.push.listenCount, 2);
      expect(c.push.assinantesVivos, 1);

      // A prova que importa: UMA rotação, UM registro.
      final antes = c.transport.countOf('POST', '/devices/register');
      c.push.rotacionar(_tokenB);
      await c.coordinator.settled();
      await Future<void>.delayed(Duration.zero);

      expect(c.transport.countOf('POST', '/devices/register') - antes, 1);
    });

    test('reentrar sem sair não acumula assinatura', () async {
      final c = montar();
      rotasDeLogin(c.transport);
      await c.coordinator.startSession();
      await c.coordinator.startSession();
      await c.coordinator.startSession();

      expect(c.push.assinantesVivos, 1);
    });
  });

  group('NF3-13 · o token não vaza em log', () {
    test('a redação cobre `pushToken` em qualquer profundidade', () {
      final redigido = Log.redact({
        'device': {'pushToken': _tokenA, 'appVersion': '0.1.0+1'},
      });

      expect(redigido.toString(), isNot(contains(_tokenA)));
      expect(redigido.toString(), contains('0.1.0+1'));
    });

    test('nenhum arquivo de push ou de autenticação imprime', () {
      final arquivos = [
        ...Directory('lib/core/push').listSync().whereType<File>(),
        File('lib/features/auth/data/auth_repository.dart'),
        File('lib/features/auth/state/session_controller.dart'),
      ];

      for (final arquivo in arquivos) {
        final fonte = arquivo
            .readAsStringSync()
            // Comentário explicativo pode citar `print`; o que se proíbe é a
            // chamada.
            .replaceAll(RegExp(r'//.*'), '')
            .replaceAll(RegExp(r'/\*[\s\S]*?\*/'), '');
        expect(
          fonte,
          isNot(matches(RegExp(r'\b(print|debugPrint)\s*\('))),
          reason: '${arquivo.path} imprime',
        );
      }
    });
  });

  group('NF3-14 · três identificadores que não se substituem', () {
    test('installationId não é o token, e não vai no registro', () async {
      final c = montar();
      rotasDeLogin(c.transport);
      await c.session.login(email: 'tech@alfa.test', password: 'x');
      await c.coordinator.settled();

      final login = Map<String, dynamic>.from(
        c.transport.requestFor('POST', '/auth/login').data as Map,
      );
      final instalacao = (login['device'] as Map)['installationId'] as String;

      expect(instalacao, isNot(_tokenA));
      expect(tokensRegistrados(c.transport), [_tokenA]);

      /*
        E o registro não reenvia identidade. `companyId`, `userId` e
        `installationId` vêm do token no servidor; oferecê-los aqui seria dar
        ao aplicativo a chance de escolher em qual linha escrever — o schema é
        `.strict()` e recusaria, mas a regra é anterior ao schema.
      */
      for (final corpo in registros(c.transport)) {
        expect(corpo.keys, isNot(contains('installationId')));
        expect(corpo.keys, isNot(contains('companyId')));
        expect(corpo.keys, isNot(contains('userId')));
        expect(corpo.keys, isNot(contains('technicianId')));
        expect(corpo.keys, isNot(contains('platform')));
      }
    });
  });

  group('NF3-15 · o token não é persistido no aparelho', () {
    test('nem no armazenamento comum, nem no seguro', () async {
      SharedPreferences.setMockInitialValues({});
      final c = montar();
      rotasDeLogin(c.transport);
      await c.session.login(email: 'tech@alfa.test', password: 'x');
      await c.coordinator.settled();

      expect(c.store.token, 'sessao-A');
      expect(c.store.insecureWrites.values, isNot(contains(_tokenA)));
      // O token de sessão é outro segredo, e também não pode estar ali.
      expect(c.store.insecureWrites.values, isNot(contains('sessao-A')));

      final prefs = await SharedPreferences.getInstance();
      for (final chave in prefs.getKeys()) {
        expect(prefs.get(chave).toString(), isNot(contains(_tokenA)));
      }
    });

    test('o coordenador não conhece armazenamento nenhum', () {
      final fonte = File('lib/core/push/push_coordinator.dart')
          .readAsStringSync();

      /*
        O SDK do Firebase é a autoridade sobre o token (`NF-2` §26). Uma cópia
        em disco criaria uma segunda verdade para sincronizar — e a que ficaria
        velha seria a nossa.
      */
      expect(fonte, isNot(contains('SharedPreferences')));
      expect(fonte, isNot(contains('secure_storage')));
      expect(fonte, isNot(contains('FlutterSecureStorage')));
    });
  });
}
