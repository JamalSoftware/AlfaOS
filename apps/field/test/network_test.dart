import 'dart:convert';
import 'dart:io';

import 'package:alfaos_field/features/network/data/network_repository.dart';
import 'package:alfaos_field/features/network/domain/network.dart';
import 'package:alfaos_field/features/network/state/network_controller.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_transport.dart';

/// # `CTO-2.5` — a rede de distribuição no aparelho
///
/// O que esta fase acrescenta não é regra de rede: é **quem consegue pedir o
/// quê, e o que o aparelho manda no corpo**. Por isso a maior parte deste
/// arquivo ataca contrato, fronteira e obsolescência.
///
/// Todas as fixturas são fictícias.
void main() {
  late FakeTransport transport;
  late NetworkRepository repo;

  const orderId = 'os-1';
  const base = '/service-orders/os-1/network';

  setUp(() {
    transport = FakeTransport();
    final store = FakeSessionStore()..token = 'token-ficticio';
    repo = NetworkRepository(api: buildTestClientWith(transport, store));
  });

  Map<String, dynamic> porta({
    String id = 'porta-4',
    int number = 4,
    String state = 'AVAILABLE',
    bool occupied = false,
    bool available = true,
  }) => {
    'id': id,
    'number': number,
    'administrativeState': state,
    'occupied': occupied,
    'availableForConnection': available,
  };

  Map<String, dynamic> vinculo({
    String state = 'AVAILABLE',
    String ctoName = 'CTO Central',
    bool ctoActive = true,
  }) => {
    'connection': {
      'connectionId': 'vinc-1',
      'cto': {
        'id': 'cto-1',
        'name': ctoName,
        'code': 'CX-01',
        'active': ctoActive,
      },
      'port': porta(state: state, occupied: true, available: false),
      'connectedAt': '2026-09-01T12:00:00.000Z',
    },
  };

  NetworkController controlador({Future<void> Function()? onOrderChanged}) =>
      NetworkController(
        repository: repo,
        orderId: orderId,
        onOrderChanged: onOrderChanged,
      );

  // -------------------------------------------------------------------------
  // Serialização
  // -------------------------------------------------------------------------

  group('modelos', () {
    test('MOD-01 estado administrativo desconhecido não estoura', () {
      final p = NetworkPort.fromJson(
        porta(state: 'ALGO_QUE_ESTE_APK_NAO_CONHECE'),
      );
      expect(p.administrativeState, PortAdministrativeState.unknown);
      // Um APK antigo diante de um enum novo mostra o rótulo neutro e NÃO
      // oferece a porta — em vez de quebrar a tela num aparelho em campo.
      expect(p.administrativeState.deservesBadge, isTrue);
      expect(p.administrativeState.label, isNotEmpty);
    });

    test('MOD-02 a porta é apresentada pelo NÚMERO, nunca pelo id', () {
      expect(NetworkPort.fromJson(porta(number: 4)).label, '04');
      expect(NetworkPort.fromJson(porta(number: 16)).label, '16');
      expect(NetworkPort.fromJson(porta(number: 256)).label, '256');
    });

    test('MOD-03 corpo incompleto não derruba a leitura', () {
      final p = NetworkPort.fromJson({'id': 'x'});
      expect(p.number, 0);
      expect(p.occupied, isFalse);
      expect(p.availableForConnection, isFalse);
      expect(
        NetworkMutationResult.fromJson({'connection': null, 'previous': null})
            .connection,
        isNull,
      );
    });

    test('MOD-04 as duas dimensões chegam separadas', () {
      final p = NetworkPort.fromJson(
        porta(state: 'DAMAGED', occupied: true, available: false),
      );
      expect(p.administrativeState, PortAdministrativeState.damaged);
      expect(p.occupied, isTrue);
    });

    test(
      'MOD-05 só o que o servidor marcou como ofertável entra na escolha',
      () {
        final detail = CandidateCtoDetail.fromJson({
          'id': 'cto-1',
          'name': 'CTO Central',
          'code': null,
          'active': true,
          'capacity': 4,
          'availablePorts': 1,
          'ports': [
            porta(id: 'p1', number: 1, occupied: true, available: false),
            porta(id: 'p2', number: 2, state: 'RESERVED', available: false),
            porta(id: 'p3', number: 3, state: 'DAMAGED', available: false),
            porta(id: 'p4', number: 4),
          ],
        });
        expect(detail.ports.length, 4);
        expect(detail.offerable.map((p) => p.id), ['p4']);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Contrato de payload
  // -------------------------------------------------------------------------

  group('contrato', () {
    const proibidos = [
      'companyId',
      'customerId',
      'technicianId',
      'serviceOrderId',
      'source',
      'connectedAt',
      'disconnectedAt',
      'createdAt',
      'actorUserId',
    ];

    Map<String, dynamic> corpoDe(String path) {
      final req = transport.requestFor('POST', path);
      final data = req.data;
      return data is String
          ? Map<String, dynamic>.from(jsonDecode(data) as Map)
          : Map<String, dynamic>.from(data as Map);
    }

    test('API-01 CONNECT manda destino e versão, e nada mais', () async {
      transport.onJson(
        'POST',
        '$base/connect',
        data: {
          'connection': {
            'connectionId': 'v1',
            'ctoId': 'cto-1',
            'ctoPortId': 'porta-4',
            'portNumber': 4,
          },
          'previous': null,
        },
      );

      await repo.connect(
        orderId,
        expectedVersion: 7,
        ctoPortId: 'porta-4',
        idempotencyKey: 'chave-connect-0001',
      );

      final corpo = corpoDe('$base/connect');
      expect(corpo.keys.toSet(), {'expectedVersion', 'ctoPortId'});
      for (final campo in proibidos) {
        expect(corpo.containsKey(campo), isFalse, reason: campo);
      }
      expect(
        transport
            .requestFor('POST', '$base/connect')
            .headers['Idempotency-Key'],
        'chave-connect-0001',
      );
    });

    test('API-02 MOVE manda o vínculo esperado e o destino', () async {
      transport.onJson(
        'POST',
        '$base/move',
        data: {'connection': null, 'previous': null},
      );

      await repo.move(
        orderId,
        expectedVersion: 7,
        expectedConnectionId: 'vinc-1',
        targetCtoPortId: 'porta-9',
        idempotencyKey: 'chave-move-0001',
      );

      final corpo = corpoDe('$base/move');
      expect(corpo.keys.toSet(), {
        'expectedVersion',
        'expectedConnectionId',
        'targetCtoPortId',
      });
      for (final campo in proibidos) {
        expect(corpo.containsKey(campo), isFalse, reason: campo);
      }
    });

    test('API-03 DISCONNECT manda o vínculo QUE A TELA VIU', () async {
      transport.onJson(
        'POST',
        '$base/disconnect',
        data: {'connection': null, 'previous': null},
      );

      await repo.disconnect(
        orderId,
        expectedVersion: 7,
        expectedConnectionId: 'vinc-1',
        idempotencyKey: 'chave-disc-0001',
      );

      final corpo = corpoDe('$base/disconnect');
      expect(corpo.keys.toSet(), {'expectedVersion', 'expectedConnectionId'});
      // Sem `customerId`: seria "desconecte o que este cliente tiver agora", e
      // uma tela velha bastaria para encerrar um vínculo que ninguém viu.
      expect(corpo.containsKey('customerId'), isFalse);
    });

    test('API-04 toda rota vive sob a OS — nenhuma é administrativa', () async {
      transport.onJson('GET', base, data: {'connection': null});
      transport.onJson('GET', '$base/ctos', data: {'ctos': []});
      transport.onJson(
        'GET',
        '$base/ctos/cto-1',
        data: {
          'cto': {
            'id': 'cto-1',
            'name': 'x',
            'code': null,
            'active': true,
            'capacity': 1,
            'availablePorts': 0,
            'ports': [],
          },
        },
      );

      await repo.current(orderId);
      await repo.candidates(orderId);
      await repo.cto(orderId, 'cto-1');

      for (final req in transport.requests) {
        expect(req.path, startsWith('/service-orders/$orderId/network'));
        expect(req.path, isNot(contains('cto-connections')));
      }
    });

    test('API-05 a busca viaja na query, não no corpo', () async {
      transport.onJson('GET', '$base/ctos', data: {'ctos': []});
      await repo.candidates(orderId, search: 'CX-01', limit: 5);
      final req = transport.requestFor('GET', '$base/ctos');
      expect(req.queryParameters['search'], 'CX-01');
      expect(req.queryParameters['limit'], 5);
    });
  });

  // -------------------------------------------------------------------------
  // Idempotência
  // -------------------------------------------------------------------------

  group('idempotência', () {
    String chaveDe(String path) =>
        transport.requestFor('POST', path).headers['Idempotency-Key'] as String;

    List<String> chavesDe(String path) => transport.requests
        .where((r) => r.method == 'POST' && r.path == path)
        .map((r) => r.headers['Idempotency-Key'] as String)
        .toList();

    test('FI-01 duplo toque produz UMA requisição', () async {
      transport.on(
        'POST',
        '$base/connect',
        FakeReply(
          status: 201,
          body: {
            'ok': true,
            'data': {'connection': null, 'previous': null},
          },
          delay: const Duration(milliseconds: 60),
        ),
      );
      transport.onJson('GET', base, data: {'connection': null});
      final c = controlador();

      // Sem esperar o primeiro: é exatamente o duplo toque do técnico.
      final primeiro = c.connect(
        expectedVersion: 1,
        ctoPortId: 'porta-4',
        ctoName: 'CTO Central',
        portLabel: '04',
      );
      final segundo = c.connect(
        expectedVersion: 1,
        ctoPortId: 'porta-4',
        ctoName: 'CTO Central',
        portLabel: '04',
      );
      await Future.wait([primeiro, segundo]);

      expect(transport.countOf('POST', '$base/connect'), 1);
    });

    test('FI-02 retentativa da MESMA intenção reusa a chave', () async {
      transport.onJson('GET', base, data: {'connection': null});
      transport.timeout = true;
      final c = controlador();

      Future<void> tentar() => c.connect(
        expectedVersion: 1,
        ctoPortId: 'porta-4',
        ctoName: 'CTO Central',
        portLabel: '04',
      );

      await tentar();
      final primeira = c.debugIntentKey('connect:porta-4');
      expect(primeira, isNotEmpty);

      await tentar();
      // Gerada no ENVIO, cada retentativa seria um comando novo e a proteção
      // simplesmente não existiria.
      expect(c.debugIntentKey('connect:porta-4'), primeira);

      final chaves = chavesDe('$base/connect');
      expect(chaves.length, 2);
      expect(chaves.toSet().length, 1);
    });

    test('FI-03 outra ação consciente ganha chave nova', () async {
      transport.onJson(
        'POST',
        '$base/connect',
        data: {'connection': null, 'previous': null},
      );
      transport.onJson('GET', base, data: {'connection': null});
      final c = controlador();

      await c.connect(
        expectedVersion: 1,
        ctoPortId: 'porta-4',
        ctoName: 'CTO Central',
        portLabel: '04',
      );
      await c.connect(
        expectedVersion: 2,
        ctoPortId: 'porta-9',
        ctoName: 'CTO Central',
        portLabel: '09',
      );

      final chaves = chavesDe('$base/connect');
      expect(chaves.length, 2);
      // Duas intenções distintas. Reapresentar a chave da primeira faria o
      // servidor responder `IDEMPOTENCY_CONFLICT` para uma operação legítima.
      expect(chaves.toSet().length, 2);
    });

    test('FI-04 MOVE e DISCONNECT não compartilham chave', () async {
      transport.onJson(
        'POST',
        '$base/move',
        data: {'connection': null, 'previous': null},
      );
      transport.onJson(
        'POST',
        '$base/disconnect',
        data: {'connection': null, 'previous': null},
      );
      transport.onJson('GET', base, data: vinculo());
      final c = controlador();

      await c.move(
        expectedVersion: 1,
        expectedConnectionId: 'vinc-1',
        targetCtoPortId: 'porta-9',
        ctoName: 'CTO Central',
        portLabel: '09',
      );
      await c.disconnect(
        expectedVersion: 2,
        expectedConnectionId: 'vinc-1',
        portLabel: '04',
      );

      expect(chaveDe('$base/move'), isNot(chaveDe('$base/disconnect')));
    });
  });

  // -------------------------------------------------------------------------
  // Obsolescência e conflito
  // -------------------------------------------------------------------------

  group('conflito', () {
    test('CF-01 DISCONNECT recusado NÃO remove o vínculo da tela', () async {
      transport.onJson('GET', base, data: vinculo());
      transport.onError(
        'POST',
        '$base/disconnect',
        status: 409,
        code: 'CONFLICT',
        message: 'Este vínculo mudou desde que a tela foi carregada.',
        conflict: true,
      );
      final c = controlador();
      await c.load();
      expect(c.state.connection, isNotNull);

      // Entre a leitura e o toque, o despacho moveu o cliente.
      transport.onJson('GET', base, data: vinculo(ctoName: 'CTO Nova'));

      final ok = await c.disconnect(
        expectedVersion: 1,
        expectedConnectionId: 'vinc-1',
        portLabel: '04',
      );

      expect(ok, isFalse);
      expect(c.state.actionMessage, isNull, reason: 'não houve sucesso');
      expect(c.state.actionError, isNotNull);
      // A releitura mostra o vínculo REAL, não a ausência de vínculo.
      expect(c.state.connection, isNotNull);
      expect(c.state.connection!.cto.name, 'CTO Nova');
    });

    test('CF-02 MOVE recusado relê e mostra o destino verdadeiro', () async {
      transport.onJson('GET', base, data: vinculo());
      transport.onError(
        'POST',
        '$base/move',
        status: 409,
        code: 'CONFLICT',
        conflict: true,
      );
      final c = controlador();
      await c.load();

      transport.onJson('GET', base, data: vinculo(ctoName: 'CTO Destino Real'));
      final ok = await c.move(
        expectedVersion: 1,
        expectedConnectionId: 'vinc-1',
        targetCtoPortId: 'porta-9',
        ctoName: 'CTO Que O Tecnico Escolheu',
        portLabel: '09',
      );

      expect(ok, isFalse);
      expect(c.state.actionMessage, isNull);
      expect(c.state.connection!.cto.name, 'CTO Destino Real');
    });

    test(
      'CF-03 conflito descarta a chave — a intenção não existe mais',
      () async {
        transport.onJson('GET', base, data: {'connection': null});
        transport.onError(
          'POST',
          '$base/connect',
          status: 409,
          code: 'CONFLICT',
          conflict: true,
        );
        final c = controlador();

        await c.connect(
          expectedVersion: 1,
          ctoPortId: 'porta-4',
          ctoName: 'CTO Central',
          portLabel: '04',
        );
        expect(c.debugIntentKey('connect:porta-4'), isEmpty);
      },
    );

    test('CF-04 a OS é relida quando a operação muda o mundo', () async {
      transport.onJson(
        'POST',
        '$base/connect',
        data: {'connection': null, 'previous': null},
      );
      transport.onJson('GET', base, data: {'connection': null});
      var releituras = 0;
      final c = controlador(onOrderChanged: () async => releituras += 1);

      await c.connect(
        expectedVersion: 1,
        ctoPortId: 'porta-4',
        ctoName: 'CTO Central',
        portLabel: '04',
      );
      // A mutação reivindica a OS e move `version`. Sem a releitura, a operação
      // seguinte nasceria com um token velho.
      expect(releituras, 1);
    });
  });

  // -------------------------------------------------------------------------
  // Online-only
  // -------------------------------------------------------------------------

  group('online-only', () {
    test(
      'ON-01 sem rede a operação não acontece e a mensagem diz isso',
      () async {
        transport.onJson('GET', base, data: vinculo());
        final c = controlador();
        await c.load();
        final antes = c.state.connection;

        transport.offline = true;
        final ok = await c.disconnect(
          expectedVersion: 1,
          expectedConnectionId: 'vinc-1',
          portLabel: '04',
        );

        expect(ok, isFalse);
        expect(c.state.actionMessage, isNull);
        expect(c.state.actionError, contains('precisa de internet'));
        // Nada de "tentaremos sincronizar depois": seria falso.
        expect(c.state.actionError, isNot(contains('sincroniz')));
        expect(c.state.actionError, isNot(contains('depois')));
        expect(c.state.connection, same(antes));
      },
    );

    test('ON-02 sem rede a chave é PRESERVADA para a mesma intenção', () async {
      transport.offline = true;
      final c = controlador();
      await c.connect(
        expectedVersion: 1,
        ctoPortId: 'porta-4',
        ctoName: 'CTO Central',
        portLabel: '04',
      );
      /*
        A chave sobrevive de propósito. Se o comando tiver chegado ao servidor e
        só a resposta se perdido, a retentativa precisa ser o MESMO comando —
        senão a operação acontece duas vezes.
      */
      expect(c.debugIntentKey('connect:porta-4'), isNotEmpty);
    });

    test('ON-03 sem rede a OS NÃO é relida', () async {
      transport.offline = true;
      var releituras = 0;
      final c = controlador(onOrderChanged: () async => releituras += 1);

      await c.connect(
        expectedVersion: 1,
        ctoPortId: 'porta-4',
        ctoName: 'CTO Central',
        portLabel: '04',
      );
      /*
        Reler traria uma `version` nova; o corpo da retentativa mudaria e o
        servidor responderia `IDEMPOTENCY_CONFLICT` em vez do replay que ela
        deve ser.
      */
      expect(releituras, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Fronteiras estruturais — sobre o FONTE, não sobre o comportamento
  // -------------------------------------------------------------------------

  group('fronteiras', () {
    final fontes = Directory('lib')
        .listSync(recursive: true)
        .whereType<File>()
        .where((f) => f.path.endsWith('.dart'))
        .toList(growable: false);

    // `uri.path` normaliza o separador em toda plataforma; `path` traz o do
    // Windows e o predicado passaria a depender de onde o teste roda.
    final rede = fontes
        .where((f) => f.uri.path.contains('lib/features/network/'))
        .toList(growable: false);

    /*
      CÓDIGO, não comentário.

      A primeira versão destes testes grepava o arquivo cru e caiu três vezes —
      nas minhas próprias frases explicando o que o módulo NÃO faz. Um teste que
      lê "não chamamos /api/cto-connections" como se fosse uma chamada mede o
      inverso do que promete, e o mesmo vale para o manifesto, cujo comentário
      diz que ACCESS_BACKGROUND_LOCATION não é pedida.
    */
    String codigo(File f) {
      final semBloco = f.readAsStringSync().replaceAll(
        RegExp(r'/\*[\s\S]*?\*/'),
        ' ',
      );
      return const LineSplitter()
          .convert(semBloco)
          .map((linha) {
            final corte = linha.indexOf('//');
            return corte < 0 ? linha : linha.substring(0, corte);
          })
          .join(' ');
    }

    test('EST-01 o módulo de rede existe e é do Field', () {
      expect(rede, isNotEmpty);
      expect(rede.length, greaterThanOrEqualTo(4));
    });

    test('EST-02 nenhum Dart chama a API administrativa', () {
      for (final f in fontes) {
        expect(
          codigo(f).contains('cto-connections'),
          isFalse,
          reason: '${f.path} alcança a superfície administrativa',
        );
      }
    });

    test('EST-03 toda rota de rede é montada sob a OS', () {
      final repo = File('lib/features/network/data/network_repository.dart');
      final fonte = codigo(repo);
      expect(fonte, contains("'/service-orders/\$orderId/network'"));
      // Uma rota global receberia a OS no corpo, e a autorização deixaria de
      // ser estrutural.
      expect(fonte, isNot(contains("'/network")));
      expect(fonte, isNot(contains("'/ctos")));
    });

    test('EST-04 a rede NÃO entra na fila offline', () {
      for (final f in rede) {
        final fonte = codigo(f);
        for (final proibido in [
          'PendingOperation',
          'SyncStatus',
          'pending_operation',
        ]) {
          expect(
            fonte.contains(proibido),
            isFalse,
            reason: '${f.path} referencia $proibido',
          );
        }
      }
    });

    test('EST-05 nenhum segredo de PPPoE atravessa o módulo', () {
      for (final f in rede) {
        final fonte = codigo(f).toLowerCase();
        for (final proibido in [
          'pppoe',
          'password',
          'credential',
          'ciphertext',
          'senha',
        ]) {
          expect(
            fonte.contains(proibido),
            isFalse,
            reason: '${f.path} menciona $proibido',
          );
        }
      }
    });

    test('EST-06 o módulo não imprime requisição nem token', () {
      for (final f in rede) {
        final fonte = codigo(f);
        for (final proibido in [
          'print(',
          'debugPrint',
          'Authorization',
          'Bearer',
        ]) {
          expect(
            fonte.contains(proibido),
            isFalse,
            reason: '${f.path} contém $proibido',
          );
        }
      }
    });

    test('EST-07 a CTO não acrescentou permissão de Android', () {
      /*
        IGUALDADE de conjunto, e não lista de proibidas: uma lista só pega o
        que alguém já imaginou. É a mesma disciplina de
        `android_permissions_test.dart`, aqui escopada ao que esta fase poderia
        ter mexido.
      */
      final xml = File('android/app/src/main/AndroidManifest.xml')
          .readAsStringSync();
      final declaradas = RegExp(
        r'<uses-permission[^>]*android:name="android.permission.([A-Z_]+)"',
      ).allMatches(xml).map((m) => m.group(1)!).toSet();
      expect(declaradas, {
        'INTERNET',
        'CAMERA',
        'POST_NOTIFICATIONS',
        'ACCESS_FINE_LOCATION',
        'ACCESS_COARSE_LOCATION',
      });
    });

    test('EST-08 nenhuma dependência nova entrou por causa da CTO', () {
      final spec = File('pubspec.yaml').readAsStringSync().toLowerCase();
      for (final proibida in [
        'google_maps',
        'flutter_map',
        'mobile_scanner',
        'qr_code',
        'barcode',
        'connectivity_plus',
      ]) {
        expect(spec.contains(proibida), isFalse, reason: proibida);
      }
    });

    test('EST-09 a lista de portas é preguiçosa, nunca uma Column ansiosa', () {
      final picker = codigo(
        File('lib/features/network/ui/network_picker.dart'),
      );
      // Uma caixa chega a 256 posições: construir todas de uma vez gasta
      // memória do aparelho por conteúdo que ninguém rolou até ver.
      expect(
        'ListView.builder'.allMatches(picker).length,
        greaterThanOrEqualTo(2),
      );
    });
  });
}
