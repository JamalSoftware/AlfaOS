import 'dart:io';

import 'package:alfaos_field/app/providers.dart';
import 'package:alfaos_field/core/location/location_service.dart';
import 'package:alfaos_field/core/media/photo_capture.dart';
import 'package:alfaos_field/features/execution/ui/execution_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_transport.dart';
import '../support/harness.dart';

/// # A tela de execução
///
/// Toda a jornada de campo pela interface real: a tela, o controlador, o
/// repositório e o cliente HTTP são os de produção. Só o transporte, o GPS e a
/// câmera são falsos — que são exatamente as três fronteiras que um teste não
/// pode atravessar.
///
/// Fixtures fictícias: nenhum nome, endereço ou identificador real.

/// GPS controlável.
class FakeLocationService implements LocationService {
  FakeLocationService(this.reading);

  LocationReading reading;
  int calls = 0;

  @override
  Future<LocationReading> current() async {
    calls += 1;
    return reading;
  }
}

/// Câmera controlável. Devolve um arquivo temporário real, porque o repositório
/// vai lê-lo para montar o multipart.
class FakePhotoCapture implements PhotoCapture {
  FakePhotoCapture({this.file});

  File? file;
  int calls = 0;

  @override
  Future<File?> takePhoto() async {
    calls += 1;
    return file;
  }

  @override
  Future<File?> pickFromGallery() async {
    calls += 1;
    return file;
  }
}

const _okPosition = LocationReading.ok(
  DeviceLocation(latitude: -23.5505, longitude: -46.6333, accuracyMeters: 9),
);

Map<String, dynamic> bundle({
  String locationStatus = 'UNCONFIRMED',
  int? locationVersion = 0,
  Map<String, dynamic>? checkIn,
  List<Map<String, dynamic>> checklist = const [],
  List<Map<String, dynamic>> evidences = const [],
  List<Map<String, dynamic>> materials = const [],
  List<Map<String, dynamic>> equipments = const [],
  Map<String, dynamic>? signature,
  List<Map<String, dynamic>> pendencies = const [],
  Map<String, dynamic>? requirements,
  Map<String, dynamic>? report,
  int version = 3,
}) {
  return {
    'orderId': 'os-1',
    'version': version,
    'executionVersion': 1,
    'report':
        report ??
        {
          'diagnosis': 'Conector com atenuação.',
          'workPerformed': 'Conector refeito.',
          'notes': null,
        },
    'location': {
      'status': locationStatus,
      'latitude': locationStatus == 'MISSING' ? null : -23.55,
      'longitude': locationStatus == 'MISSING' ? null : -46.63,
      'accuracyMeters': null,
      'source': locationStatus == 'MISSING' ? null : 'IMPORTED',
      'verified': locationStatus == 'CONFIRMED',
      'reference': null,
      'version': locationVersion,
    },
    'checkIn': checkIn,
    'checklist': checklist,
    'evidences': evidences,
    'materials': materials,
    'equipments': equipments,
    'signature': signature,
    'contactAttempts': const [],
    'impediments': const [],
    'requirements':
        requirements ??
        {
          'requireChecklist': false,
          'requireSignature': false,
          'requireMaterials': false,
          'requireEquipment': false,
          'requireCheckIn': false,
          'minEvidenceCount': 0,
          'requiredEvidenceCategories': const [],
        },
    'pendencies': pendencies,
  };
}

/// Dá frames para a rede em voo ANTES de assentar.
///
/// `pumpAndSettle` sozinho volta assim que nenhum frame está agendado — e logo
/// depois de `pumpWidget` isso acontece com o carregamento ainda PENDENTE, sem
/// nunca dar ao `Future` do HTTP a chance de resolver. Os pulsos abaixo cobrem
/// a resposta; o `pumpAndSettle` final cobre a transição de quem a consome.
Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 60));
  }
  await tester.pumpAndSettle(const Duration(milliseconds: 50));
}

Future<({Harness harness, FakeLocationService gps, FakePhotoCapture camera})>
abrir(
  WidgetTester tester, {
  Map<String, dynamic>? payload,
  LocationReading location = _okPosition,
  File? photo,
  List<Map<String, dynamic>> stock = const [],
}) async {
  /*
    Viewport ALTO de propósito.

    A tela é uma `ListView`, que constrói sob demanda: numa janela de teste
    padrão (800×600) as seções abaixo da dobra — materiais, equipamentos,
    assinatura, conclusão — simplesmente não existem na árvore, e `find.text`
    devolve zero por elas nunca terem sido construídas, não por estarem
    ausentes. Rolar em cada teste esconderia a intenção; um viewport que cabe a
    tela inteira deixa cada teste falar do que ele quer afirmar.
  */
  tester.view.physicalSize = const Size(1200, 5000);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);

  final harness = Harness();
  final gps = FakeLocationService(location);
  final camera = FakePhotoCapture(file: photo);

  harness.transport.onJson(
    'GET',
    '/service-orders/os-1/execution',
    data: payload ?? bundle(),
  );
  harness.transport.onJson('GET', '/inventory', data: {'items': stock});

  await harness.pump(
    tester,
    const ExecutionScreen(orderId: 'os-1'),
    extraOverrides: [
      locationServiceProvider.overrideWithValue(gps),
      photoCaptureProvider.overrideWithValue(camera),
    ],
  );
  await settle(tester);

  return (harness: harness, gps: gps, camera: camera);
}

void main() {
  group('localização', () {
    /*
      Um teste por estado, e não um laço dentro de um só.

      Montar duas telas no mesmo `testWidgets` derruba o `ProviderScope` da
      primeira com o carregamento dela ainda em voo, e o controlador morto vira
      um travamento sem mensagem. Separados, cada caso tem seu ciclo de vida —
      e o relatório diz QUAL estado quebrou.
    */
    for (final (status, label) in [
      ('CONFIRMED', 'Confirmada'),
      ('UNCONFIRMED', 'Não confirmada'),
      ('MISSING', 'Sem localização'),
    ]) {
      testWidgets('estado $status aparece como "$label"', (tester) async {
        await abrir(tester, payload: bundle(locationStatus: status));
        expect(find.text(label), findsOneWidget);
      });
    }

    testWidgets('ponto já confirmado não oferece CONFIRMAR de novo', (
      tester,
    ) async {
      await abrir(tester, payload: bundle(locationStatus: 'CONFIRMED'));
      expect(find.text('Confirmar localização'), findsNothing);
      // Corrigir continua disponível: um ponto confirmado pode estar errado.
      expect(find.text('Corrigir'), findsOneWidget);
    });

    testWidgets('sem ponto nenhum, a saída é corrigir — que cria', (
      tester,
    ) async {
      await abrir(tester, payload: bundle(locationStatus: 'MISSING'));
      expect(find.text('Confirmar localização'), findsNothing);
      expect(find.text('Corrigir'), findsOneWidget);
    });

    testWidgets('confirmar exige aceite explícito antes de enviar', (
      tester,
    ) async {
      final h = await abrir(tester);
      h.harness.transport.onJson(
        'POST',
        '/service-orders/os-1/location/confirm',
        data: {},
      );

      await tester.tap(find.text('Confirmar localização'));
      await settle(tester);

      // O diálogo é onde a PESSOA afirma que está no endereço. O GPS sozinho
      // não confirma nada (PRD §172).
      expect(find.text('Você está no endereço do cliente?'), findsOneWidget);
      expect(
        h.harness.transport.countOf(
          'POST',
          '/service-orders/os-1/location/confirm',
        ),
        0,
      );

      await tester.tap(find.text('Cancelar'));
      await settle(tester);
      expect(
        h.harness.transport.countOf(
          'POST',
          '/service-orders/os-1/location/confirm',
        ),
        0,
        reason: 'cancelar não pode enviar',
      );

      await tester.tap(find.text('Confirmar localização'));
      await settle(tester);
      await tester.tap(find.text('Confirmar'));
      await settle(tester);

      final request = h.harness.transport.requestFor(
        'POST',
        '/service-orders/os-1/location/confirm',
      );
      final body = request.data as Map<String, dynamic>;
      // A versão é a da LOCALIZAÇÃO (0), não a da OS (3).
      expect(body['expectedVersion'], 0);
      expect(body['observedLatitude'], -23.5505);
      expect(request.headers['Idempotency-Key'], isNotNull);
    });

    testWidgets('permissão negada avisa e NÃO trava a tela', (tester) async {
      final h = await abrir(
        tester,
        location: const LocationReading.failed(
          LocationOutcome.permissionDenied,
        ),
      );
      h.harness.transport.onJson(
        'POST',
        '/service-orders/os-1/location/confirm',
        data: {},
      );

      await tester.tap(find.text('Confirmar localização'));
      await settle(tester);
      await tester.tap(find.text('Confirmar'));
      await settle(tester);

      /*
        O que importa aqui é NÃO TRAVAR.

        A frase da permissão aparece num toast e é substituída pelo toast de
        sucesso logo em seguida — asseverar o texto seria testar a ordem de
        dois SnackBars, não a regra. A regra é: sem GPS a confirmação ACONTECE,
        porque quem está declarando que o ponto está certo é o técnico, e a
        coordenada era apenas a referência do registro.

        O texto de cada recusa é coberto separadamente, em `location_test`.
      */
      expect(
        h.harness.transport.countOf(
          'POST',
          '/service-orders/os-1/location/confirm',
        ),
        1,
      );
      expect(h.gps.calls, 1);
      // E o resto da tela continua utilizável.
      expect(find.text('FAZER CHECK-IN'), findsOneWidget);
    });
  });

  group('check-in', () {
    testWidgets('envia e depois mostra hora e distância', (tester) async {
      final h = await abrir(tester);
      h.harness.transport.onJson(
        'POST',
        '/service-orders/os-1/check-in',
        data: {},
      );
      h.harness.transport.onJson(
        'GET',
        '/service-orders/os-1/execution',
        data: bundle(
          checkIn: {
            'id': 'ci-1',
            'checkedInAt': '2026-08-28T14:05:00.000Z',
            'distanceMeters': 18,
            'hasCoordinate': true,
          },
        ),
      );

      await tester.tap(find.text('FAZER CHECK-IN'));
      await settle(tester);

      final body =
          h.harness.transport
                  .requestFor('POST', '/service-orders/os-1/check-in')
                  .data
              as Map<String, dynamic>;
      expect(body['expectedVersion'], 3);
      expect(body['latitude'], -23.5505);

      expect(find.textContaining('Check-in realizado'), findsOneWidget);
      expect(find.textContaining('18 m'), findsOneWidget);
      expect(find.text('FAZER CHECK-IN'), findsNothing);
    });

    testWidgets('sem GPS o check-in acontece do mesmo jeito', (tester) async {
      final h = await abrir(
        tester,
        location: const LocationReading.failed(LocationOutcome.unavailable),
      );
      h.harness.transport.onJson(
        'POST',
        '/service-orders/os-1/check-in',
        data: {},
      );

      await tester.tap(find.text('FAZER CHECK-IN'));
      await settle(tester);

      final body =
          h.harness.transport
                  .requestFor('POST', '/service-orders/os-1/check-in')
                  .data
              as Map<String, dynamic>;
      // A chegada é o fato; a coordenada é o detalhe.
      expect(body.containsKey('latitude'), isFalse);
      expect(body['expectedVersion'], 3);
    });
  });

  group('fotos', () {
    /*
      A resiliência da foto (§58) é testada no CONTROLADOR, não aqui.

      O envio real monta um multipart a partir de um `File`, e ler arquivo é
      I/O de verdade: dentro da zona de tempo falso do `flutter_test` ele nunca
      completa, e o teste pendura em vez de falhar. `execution_controller_test`
      exercita o mesmo caminho com um repositório dublê, sem tocar disco.
    */

    testWidgets('a categoria é escolhida ANTES de abrir a câmera', (
      tester,
    ) async {
      final h = await abrir(tester);

      await tester.tap(find.text('ADICIONAR FOTO'));
      await settle(tester);

      // Escolhida depois, o técnico já estaria com a foto na mão e marcaria
      // qualquer coisa para seguir adiante.
      expect(find.text('Que foto é esta?'), findsOneWidget);
      expect(find.text('ONU / ONT'), findsOneWidget);
      expect(h.camera.calls, 0);
    });

    testWidgets('mostra as categorias obrigatórias da política', (
      tester,
    ) async {
      await abrir(
        tester,
        payload: bundle(
          requirements: {
            'requireChecklist': false,
            'requireSignature': false,
            'requireMaterials': false,
            'requireEquipment': false,
            'requireCheckIn': false,
            'minEvidenceCount': 2,
            'requiredEvidenceCategories': ['ONU_ONT'],
          },
        ),
      );

      expect(find.textContaining('Obrigatórias: ONU / ONT'), findsOneWidget);
      expect(find.textContaining('Mínimo de 2 foto'), findsOneWidget);
    });
  });

  group('checklist', () {
    testWidgets('item de foto não oferece resposta — ele quer a evidência', (
      tester,
    ) async {
      await abrir(
        tester,
        payload: bundle(
          checklist: [
            {
              'id': 'c1',
              'label': 'Foto da ONU',
              'type': 'PHOTO',
              'required': true,
              'evidenceCategory': 'ONU_ONT',
              'options': const [],
            },
            {
              'id': 'c2',
              'label': 'Cabo testado?',
              'type': 'BOOLEAN',
              'required': true,
              'options': const [],
            },
          ],
        ),
      );

      expect(find.text('Foto da ONU'), findsOneWidget);
      expect(find.textContaining('Satisfeito com a foto'), findsOneWidget);
      // Um botão de responder sugeriria que dá para marcá-lo sem a foto existir.
      expect(find.byTooltip('Responder'), findsOneWidget);
    });

    testWidgets('responder envia o valor tipado e a versão da OS', (
      tester,
    ) async {
      final h = await abrir(
        tester,
        payload: bundle(
          checklist: [
            {
              'id': 'c2',
              'label': 'Cabo testado?',
              'type': 'BOOLEAN',
              'required': true,
              'options': const [],
            },
          ],
        ),
      );
      h.harness.transport.onJson(
        'POST',
        '/service-orders/os-1/checklist/c2',
        data: {},
      );

      await tester.tap(find.byTooltip('Responder'));
      await settle(tester);
      await tester.tap(find.byType(SwitchListTile));
      await settle(tester);
      await tester.tap(find.text('Salvar resposta'));
      await settle(tester);

      final request = h.harness.transport.requestFor(
        'POST',
        '/service-orders/os-1/checklist/c2',
      );
      final body = request.data as Map<String, dynamic>;
      expect(body['valueBoolean'], true);
      expect(body['expectedVersion'], 3);
      expect(request.headers['Idempotency-Key'], isNotNull);
    });
  });

  group('materiais', () {
    testWidgets('sem saldo, o botão explica em vez de sumir', (tester) async {
      await abrir(tester, stock: const []);
      expect(find.text('Sem saldo no seu estoque'), findsOneWidget);
    });

    testWidgets('lista o estoque do técnico com saldo', (tester) async {
      await abrir(
        tester,
        stock: [
          {
            'itemId': 'i1',
            'code': 'CABO-DROP',
            'name': 'Cabo drop óptico',
            'unit': 'METER',
            'balance': '100',
          },
        ],
      );

      await tester.tap(find.text('Registrar material'));
      await settle(tester);
      expect(find.textContaining('Cabo drop óptico'), findsWidgets);
      // O saldo é orientação — quem valida é o servidor, sob lock.
      expect(find.textContaining('Disponível: 100'), findsOneWidget);
    });
  });

  group('assinatura', () {
    testWidgets('confirmar fica desabilitado sem traço e sem nome', (
      tester,
    ) async {
      await abrir(tester);

      await tester.tap(find.text('Coletar assinatura'));
      await settle(tester);

      final confirm = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'CONFIRMAR'),
      );
      // Assinatura vazia não é assinatura, e um PNG de um pixel é uma imagem
      // válida que o servidor aceitaria.
      expect(confirm.onPressed, isNull);
    });

    testWidgets('avisa quando a assinatura ficou obsoleta', (tester) async {
      await abrir(
        tester,
        payload: bundle(
          signature: {
            'id': 's1',
            'signerName': 'Cliente Ficticio',
            'signedAt': '2026-08-28T14:00:00.000Z',
            'stale': true,
          },
        ),
      );

      expect(find.textContaining('mudou depois da assinatura'), findsOneWidget);
    });
  });

  group('conclusão', () {
    testWidgets('com pendência o botão fica travado e a lista aparece', (
      tester,
    ) async {
      await abrir(
        tester,
        payload: bundle(
          pendencies: [
            {'code': 'SIGNATURE_REQUIRED', 'message': 'Falta a assinatura.'},
            {'code': 'CHECK_IN_REQUIRED', 'message': 'Faça o check-in.'},
          ],
        ),
      );

      expect(find.text('Não é possível concluir:'), findsOneWidget);
      expect(find.text('Falta a assinatura.'), findsOneWidget);
      expect(find.text('Faça o check-in.'), findsOneWidget);
      // O código interno NUNCA aparece para o técnico.
      expect(find.textContaining('SIGNATURE_REQUIRED'), findsNothing);

      final button = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'CONCLUIR ATENDIMENTO'),
      );
      expect(button.onPressed, isNull);
    });

    testWidgets('sem pendência conclui e manda as DUAS versões', (
      tester,
    ) async {
      final h = await abrir(tester);
      h.harness.transport.onJson(
        'POST',
        '/service-orders/os-1/complete',
        data: {},
      );

      await tester.tap(find.text('CONCLUIR ATENDIMENTO'));
      await settle(tester);

      final request = h.harness.transport.requestFor(
        'POST',
        '/service-orders/os-1/complete',
      );
      final body = request.data as Map<String, dynamic>;
      expect(body['expectedVersion'], 3);
      // A da execução é OUTRA, e as duas viajam.
      expect(body['expectedExecutionVersion'], 1);
      expect(request.headers['Idempotency-Key'], isNotNull);
    });

    testWidgets('pendências devolvidas pelo servidor substituem a leitura', (
      tester,
    ) async {
      final h = await abrir(tester);
      // A tela leu "pode concluir", mas o servidor recusa: entre as duas, a
      // resposta ao COMANDO é a que vale.
      //
      // Montado à mão porque `onError` não carrega `pendencies` — que é
      // justamente o campo aditivo que a v0.10 acrescentou ao contrato.
      h.harness.transport.on(
        'POST',
        '/service-orders/os-1/complete',
        const FakeReply(
          status: 400,
          body: {
            'ok': false,
            'error': {
              'code': 'VALIDATION_ERROR',
              'message': 'Falta a foto da ONU.',
              'retryable': false,
              'conflict': false,
              'pendencies': [
                {
                  'code': 'EVIDENCE_CATEGORY_MISSING',
                  'message': 'Falta a foto da ONU.',
                  'category': 'ONU_ONT',
                },
              ],
            },
          },
        ),
      );

      await tester.tap(find.text('CONCLUIR ATENDIMENTO'));
      await settle(tester);

      expect(find.text('Não é possível concluir:'), findsOneWidget);
      expect(find.text('Falta a foto da ONU.'), findsOneWidget);
    });

    testWidgets('409 recarrega em vez de reenviar', (tester) async {
      final h = await abrir(tester);
      h.harness.transport.onError(
        'POST',
        '/service-orders/os-1/complete',
        status: 409,
        code: 'CONFLICT',
        message: 'A OS foi modificada.',
        conflict: true,
      );

      await tester.tap(find.text('CONCLUIR ATENDIMENTO'));
      await settle(tester);

      expect(
        h.harness.transport.countOf('POST', '/service-orders/os-1/complete'),
        1,
        reason: 'conflito não pode virar reenvio automático',
      );
      // Recarregou: duas leituras do pacote (a inicial e a do conflito).
      expect(
        h.harness.transport.countOf('GET', '/service-orders/os-1/execution'),
        greaterThanOrEqualTo(2),
      );
    });
  });

  group('progresso', () {
    testWidgets('conta apenas as etapas que a política exige', (tester) async {
      await abrir(
        tester,
        payload: bundle(
          requirements: {
            'requireChecklist': false,
            'requireSignature': true,
            'requireMaterials': false,
            'requireEquipment': false,
            'requireCheckIn': true,
            'minEvidenceCount': 0,
            'requiredEvidenceCategories': const [],
          },
          pendencies: [
            {'code': 'SIGNATURE_REQUIRED', 'message': 'Falta a assinatura.'},
            {'code': 'CHECK_IN_REQUIRED', 'message': 'Faça o check-in.'},
          ],
        ),
      );

      // Relatório (feito) + check-in + assinatura = 3 etapas, 1 concluída. Uma
      // barra que contasse etapas não exigidas nunca chegaria ao fim.
      expect(find.text('1 de 3 etapas concluídas'), findsOneWidget);
    });
  });
}
