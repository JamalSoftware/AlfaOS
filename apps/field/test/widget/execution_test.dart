import 'dart:io';

import 'package:alfaos_field/app/providers.dart';
import 'package:alfaos_field/core/location/location_service.dart';
import 'package:alfaos_field/core/location/operational_position.dart';
import 'package:alfaos_field/core/media/photo_capture.dart';
import 'package:alfaos_field/features/execution/ui/execution_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_position_source.dart';
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

/// GPS controlável do CHECK-IN — que aceita a leitura que vier. Confirmar e
/// Corrigir usam a captura (`FakePositionSource`), desde a RC-1C-HOTFIX.
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

/// O ponto cadastrado dos cenários: ~15 m de `_okPosition` — perto o bastante
/// para confirmar (RC-1C).
const _pontoLat = -23.5504;
const _pontoLng = -46.6332;

/// A leitura boa da captura: no mesmo lugar de `_okPosition`, 9 m de precisão.
const _pertoPreciso = ScriptedReading(-23.5505, -46.6333, accuracy: 9);

/// ~1,8 km ao norte, com os 2000 m da posição APROXIMADA do Android — a
/// leitura do caso físico.
const _aproximada = ScriptedReading(-23.5343, -46.6333, accuracy: 2000);

Map<String, dynamic> bundle({
  String locationStatus = 'UNCONFIRMED',
  int? locationVersion = 0,
  int? confirmMaxDistanceMeters = 100,
  int? gpsMaxAccuracyMeters = 50,
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
      'latitude': locationStatus == 'MISSING' ? null : _pontoLat,
      'longitude': locationStatus == 'MISSING' ? null : _pontoLng,
      'accuracyMeters': null,
      'source': locationStatus == 'MISSING' ? null : 'IMPORTED',
      'verified': locationStatus == 'CONFIRMED',
      'reference': null,
      'version': locationVersion,
      'confirmMaxDistanceMeters': ?confirmMaxDistanceMeters,
      'gpsMaxAccuracyMeters': ?gpsMaxAccuracyMeters,
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

Future<
  ({
    Harness harness,
    FakeLocationService gps,
    FakePositionSource captura,
    FakePhotoCapture camera,
  })
>
abrir(
  WidgetTester tester, {
  Map<String, dynamic>? payload,
  LocationReading location = _okPosition,
  FakePositionSource? captura,
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
  final fonte = captura ?? FakePositionSource(script: const [_pertoPreciso]);
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
      positionSourceProvider.overrideWithValue(fonte),
      photoCaptureProvider.overrideWithValue(camera),
    ],
  );
  await settle(tester);

  return (harness: harness, gps: gps, captura: fonte, camera: camera);
}

/// Pulsos curtos: a captura está procurando, com a barra de progresso
/// animando — `pumpAndSettle` não assentaria.
Future<void> buscando(WidgetTester tester) async {
  for (var i = 0; i < 4; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

/// O tempo da captura esgota (20 s, no relógio falso do teste).
Future<void> esgotarCaptura(WidgetTester tester) async {
  await tester.pump(const Duration(seconds: 21));
  await settle(tester);
}

int _posts(Harness h, String rota) =>
    h.transport.countOf('POST', '/service-orders/os-1/location/$rota');

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

    testWidgets(
      'confirmar CAPTURA antes, mostra distância e precisão, e exige aceite',
      (tester) async {
        final h = await abrir(tester);
        h.harness.transport.onJson(
          'POST',
          '/service-orders/os-1/location/confirm',
          data: {},
        );

        await tester.tap(find.text('Confirmar localização'));
        await settle(tester);

        // O diálogo é onde a PESSOA afirma que está no endereço — agora com a
        // distância à vista (RC-1C). O GPS sozinho não confirma nada (§172).
        expect(find.text('Você está no endereço do cliente?'), findsOneWidget);
        expect(find.text('Distância da sua posição: 15 m'), findsOneWidget);
        expect(find.text('Precisão do GPS: 9 m'), findsOneWidget);
        expect(_posts(h.harness, 'confirm'), 0);

        await tester.tap(find.text('Cancelar'));
        await settle(tester);
        expect(_posts(h.harness, 'confirm'), 0, reason: 'cancelar não envia');

        await tester.tap(find.text('Confirmar localização'));
        await settle(tester);
        await tester.tap(find.byKey(const Key('confirm-location-submit')));
        await settle(tester);

        final request = h.harness.transport.requestFor(
          'POST',
          '/service-orders/os-1/location/confirm',
        );
        final body = request.data as Map<String, dynamic>;
        // A versão é a da LOCALIZAÇÃO (0), não a da OS (3).
        expect(body['expectedVersion'], 0);
        // A posição enviada é a MESMA que foi capturada e mostrada — com a
        // precisão REAL, que o servidor julga sem arredondar.
        expect(body['observedLatitude'], -23.5505);
        expect(body['observedLongitude'], -46.6333);
        expect(body['observedAccuracyMeters'], 9.0);
        // Nenhuma distância viaja: quem mede, para valer, é o servidor.
        expect(body.containsKey('distanceMeters'), isFalse);
        expect(request.headers['Idempotency-Key'], isNotNull);
        // Uma captura por tentativa; o GPS do check-in não entra aqui.
        expect(h.captura.watchCalls, 2);
        expect(h.gps.calls, 0);
        // E o GPS foi desligado depois de cada captura.
        expect(h.captura.listening, isFalse);
      },
    );

    testWidgets(
      'o caso físico: a leitura APROXIMADA (2000 m, ~1,8 km) aparece como precisão atual e NÃO é usada',
      (tester) async {
        final h = await abrir(
          tester,
          captura: FakePositionSource(
            script: [
              _aproximada,
              ScriptedReading(
                _pertoPreciso.latitude,
                _pertoPreciso.longitude,
                accuracy: 12,
                after: const Duration(seconds: 3),
              ),
            ],
          ),
        );
        h.harness.transport.onJson(
          'POST',
          '/service-orders/os-1/location/confirm',
          data: {},
        );

        await tester.tap(find.text('Confirmar localização'));
        await buscando(tester);
        expect(find.text('Buscando uma localização precisa…'), findsOneWidget);
        expect(find.text('Precisão atual: 2000 m'), findsOneWidget);
        expect(find.text('Precisão necessária: até 50 m.'), findsOneWidget);
        // Nada de "Longe do ponto" por causa de uma posição que não vale.
        expect(find.text('Longe do ponto cadastrado'), findsNothing);

        await tester.pump(const Duration(seconds: 3));
        await settle(tester);
        expect(find.text('Distância da sua posição: 15 m'), findsOneWidget);
        expect(find.text('Precisão do GPS: 12 m'), findsOneWidget);

        await tester.tap(find.byKey(const Key('confirm-location-submit')));
        await settle(tester);
        final body =
            h.harness.transport
                    .requestFor('POST', '/service-orders/os-1/location/confirm')
                    .data
                as Map<String, dynamic>;
        expect(body['observedLatitude'], _pertoPreciso.latitude);
        expect(body['observedAccuracyMeters'], 12.0);
      },
    );

    testWidgets(
      'precisão insuficiente: mostra os metros, esgota, NÃO envia — e tentar de novo abre captura nova',
      (tester) async {
        final h = await abrir(
          tester,
          captura: FakePositionSource(
            script: const [ScriptedReading(-23.5505, -46.6333, accuracy: 74)],
          ),
        );

        await tester.tap(find.text('Confirmar localização'));
        await buscando(tester);
        expect(find.text('Precisão atual: 74 m'), findsOneWidget);

        await esgotarCaptura(tester);
        expect(find.text('Precisão do GPS insuficiente'), findsOneWidget);
        expect(
          find.text(
            'Precisão do GPS insuficiente: 74 m. Precisão necessária: até '
            '50 m. Aguarde alguns segundos em um local mais aberto e tente '
            'novamente.',
          ),
          findsOneWidget,
        );
        expect(find.text('Você está no endereço do cliente?'), findsNothing);
        expect(_posts(h.harness, 'confirm'), 0);
        expect(h.captura.listening, isFalse);

        // Melhorou: a tentativa nova usa a leitura NOVA.
        h.captura.script = const [
          ScriptedReading(-23.5505, -46.6333, accuracy: 18),
        ];
        await tester.tap(find.byKey(const Key('fix-retry')));
        await settle(tester);
        expect(h.captura.watchCalls, 2);
        expect(find.text('Precisão do GPS: 18 m'), findsOneWidget);
        expect(_posts(h.harness, 'confirm'), 0, reason: 'ainda falta o aceite');
      },
    );

    testWidgets(
      'nenhuma leitura em 20 s: a mensagem de tempo esgotado, e a tela continua utilizável',
      (tester) async {
        final h = await abrir(tester, captura: FakePositionSource());

        await tester.tap(find.text('Confirmar localização'));
        await buscando(tester);
        expect(find.byKey(const Key('fix-current-accuracy')), findsNothing);
        await esgotarCaptura(tester);

        expect(
          find.text(
            'Não foi possível obter uma localização com precisão suficiente. '
            'Precisão necessária: até 50 m. Vá para um local mais aberto, '
            'aguarde alguns segundos e tente novamente.',
          ),
          findsOneWidget,
        );
        await tester.tap(find.byKey(const Key('fix-close')));
        await settle(tester);
        expect(_posts(h.harness, 'confirm'), 0);
        expect(find.text('FAZER CHECK-IN'), findsOneWidget);
        expect(find.text('Confirmar localização'), findsOneWidget);
      },
    );

    testWidgets('cancelar a busca não envia nada e desliga o GPS', (
      tester,
    ) async {
      final h = await abrir(
        tester,
        captura: FakePositionSource(
          script: const [ScriptedReading(-23.5505, -46.6333, accuracy: 90)],
        ),
      );

      await tester.tap(find.text('Confirmar localização'));
      await buscando(tester);
      expect(h.captura.listening, isTrue);

      await tester.tap(find.byKey(const Key('fix-cancel')));
      await settle(tester);
      expect(find.text('Buscando uma localização precisa…'), findsNothing);
      expect(h.captura.listening, isFalse);
      expect(_posts(h.harness, 'confirm'), 0);
    });

    testWidgets(
      'só a localização APROXIMADA: pede a precisa; recusada, orienta e não mede',
      (tester) async {
        final h = await abrir(
          tester,
          captura: FakePositionSource(precise: false),
        );

        await tester.tap(find.text('Confirmar localização'));
        await settle(tester);

        expect(find.text('Localização precisa desativada'), findsOneWidget);
        expect(
          find.textContaining(
            'Ative Localização precisa para usar esta função.',
          ),
          findsOneWidget,
        );
        expect(h.captura.requestCalls, 1);
        expect(h.captura.watchCalls, 0);
        expect(_posts(h.harness, 'confirm'), 0);
      },
    );

    testWidgets(
      'longe do ponto: mostra a distância, NÃO oferece Confirmar e leva a Corrigir',
      (tester) async {
        // ~2,36 km ao norte do ponto cadastrado — com GPS BOM (14 m): a
        // precisão passa, e quem recusa é a regra dos 100 m.
        final h = await abrir(
          tester,
          captura: FakePositionSource(
            script: const [ScriptedReading(-23.529203, -46.6332, accuracy: 14)],
          ),
        );

        await tester.tap(find.text('Confirmar localização'));
        await settle(tester);

        expect(find.text('Longe do ponto cadastrado'), findsOneWidget);
        expect(find.text('Distância da sua posição: 2,36 km'), findsOneWidget);
        expect(find.text('Precisão do GPS: 14 m'), findsOneWidget);
        expect(
          find.text(
            'Você está muito distante do ponto cadastrado. '
            'Use Corrigir localização.',
          ),
          findsOneWidget,
        );
        expect(find.byKey(const Key('confirm-location-submit')), findsNothing);
        expect(find.widgetWithText(FilledButton, 'Confirmar'), findsNothing);

        // A saída é a correção, a um toque.
        await tester.tap(find.byKey(const Key('confirm-location-go-correct')));
        await settle(tester);
        expect(find.text('Corrigir endereço e localização'), findsOneWidget);
        expect(_posts(h.harness, 'confirm'), 0);
      },
    );

    testWidgets('no limite (100 m) confirma; a 101 m não', (tester) async {
      // 100 e 101 m ao norte do ponto, pela mesma haversine do servidor.
      const metro = 180 / (3.141592653589793 * 6371008.8);
      final h = await abrir(
        tester,
        captura: FakePositionSource(
          script: const [
            ScriptedReading(_pontoLat + 100 * metro, _pontoLng, accuracy: 8),
          ],
        ),
      );
      await tester.tap(find.text('Confirmar localização'));
      await settle(tester);
      expect(find.text('Distância da sua posição: 100 m'), findsOneWidget);
      expect(find.byKey(const Key('confirm-location-submit')), findsOneWidget);
      await tester.tap(find.text('Cancelar'));
      await settle(tester);

      h.captura.script = const [
        ScriptedReading(_pontoLat + 101 * metro, _pontoLng, accuracy: 8),
      ];
      await tester.tap(find.text('Confirmar localização'));
      await settle(tester);
      expect(find.text('Distância da sua posição: 101 m'), findsOneWidget);
      expect(find.byKey(const Key('confirm-location-submit')), findsNothing);
      expect(find.text('Longe do ponto cadastrado'), findsOneWidget);
    });

    testWidgets('o limite é o que o SERVIDOR mandou no pacote', (tester) async {
      // Com 10 m no pacote, os ~15 m do cenário já não permitem confirmar.
      await abrir(tester, payload: bundle(confirmMaxDistanceMeters: 10));
      await tester.tap(find.text('Confirmar localização'));
      await settle(tester);
      expect(find.text('Longe do ponto cadastrado'), findsOneWidget);
      expect(find.byKey(const Key('confirm-location-submit')), findsNothing);
    });

    testWidgets(
      'GPS negado: NÃO confirma, explica, e a tela continua utilizável',
      (tester) async {
        final h = await abrir(
          tester,
          captura: FakePositionSource(
            permission: PositionPermission.denied,
            permissionAfterRequest: PositionPermission.denied,
          ),
        );
        h.harness.transport.onJson(
          'POST',
          '/service-orders/os-1/location/confirm',
          data: {},
        );

        await tester.tap(find.text('Confirmar localização'));
        await settle(tester);

        /*
          Antes da RC-1C, sem GPS a confirmação ACONTECIA — o técnico declarava
          e a coordenada era "só referência". O dono decidiu o contrário:
          confirmar exige a posição do aparelho, porque é contra ela que se
          mede a distância. Sem ela, a captura explica, e não há medida.
        */
        expect(find.text('Permissão de localização'), findsOneWidget);
        expect(
          find.text(
            'A permissão de localização não foi concedida. Permita o acesso à '
            'localização para continuar.',
          ),
          findsOneWidget,
        );
        expect(find.byKey(const Key('confirm-location-submit')), findsNothing);

        await tester.tap(find.byKey(const Key('fix-close')));
        await settle(tester);
        expect(_posts(h.harness, 'confirm'), 0);
        expect(h.captura.watchCalls, 0, reason: 'sem permissão, não mede');
        // E o resto da tela continua utilizável.
        expect(find.text('FAZER CHECK-IN'), findsOneWidget);
        expect(find.text('Confirmar localização'), findsOneWidget);
      },
    );

    testWidgets('GPS indisponível: a frase NÃO diz para continuar sem ele', (
      tester,
    ) async {
      await abrir(
        tester,
        captura: FakePositionSource()..streamError = StateError('sem fix'),
      );
      await tester.tap(find.text('Confirmar localização'));
      await settle(tester);
      expect(
        find.text(
          'Não foi possível obter a localização agora. Tente novamente.',
        ),
        findsOneWidget,
      );
      expect(find.textContaining('continuar sem ela'), findsNothing);
    });

    testWidgets(
      'a recusa do servidor aparece — e o ponto não vira confirmado',
      (tester) async {
        final h = await abrir(tester);
        h.harness.transport.onError(
          'POST',
          '/service-orders/os-1/location/confirm',
          status: 400,
          code: 'VALIDATION_ERROR',
          message: 'Você está a 120 m do ponto cadastrado. Use Corrigir localização.',
        );

        await tester.tap(find.text('Confirmar localização'));
        await settle(tester);
        await tester.tap(find.byKey(const Key('confirm-location-submit')));
        await settle(tester);

        expect(
          find.text(
            'Você está a 120 m do ponto cadastrado. Use Corrigir localização.',
          ),
          findsOneWidget,
        );
        expect(find.text('Não confirmada'), findsOneWidget);
      },
    );
  });

  group('corrigir localização (RC-1C-HOTFIX)', () {
    Future<void> abrirFolha(WidgetTester tester) async {
      await tester.tap(find.text('Corrigir'));
      await settle(tester);
      expect(find.text('Corrigir endereço e localização'), findsOneWidget);
    }

    testWidgets(
      'com GPS: captura no salvar, envia a posição CAPTURADA, e a seção sai de "Sem localização"',
      (tester) async {
        /*
          A pergunta da validação física: depois de uma correção, a tela ainda
          dizia "Sem localização". A seção mostra o que o SERVIDOR diz, relido
          depois do comando — e o comando só sai com uma posição dentro do
          contrato.
        */
        final h = await abrir(
          tester,
          payload: bundle(locationStatus: 'MISSING', locationVersion: null),
        );
        expect(find.text('Sem localização'), findsOneWidget);
        h.harness.transport.onJson(
          'POST',
          '/service-orders/os-1/location/correct',
          data: {},
        );

        await abrirFolha(tester);
        // O servidor, depois do comando, tem o ponto — verificado.
        h.harness.transport.onJson(
          'GET',
          '/service-orders/os-1/execution',
          data: bundle(locationStatus: 'CONFIRMED', locationVersion: 1),
        );
        await tester.tap(find.byKey(const Key('correct-location-submit')));
        await settle(tester);

        final body =
            h.harness.transport
                    .requestFor('POST', '/service-orders/os-1/location/correct')
                    .data
                as Map<String, dynamic>;
        expect(body['latitude'], _pertoPreciso.latitude);
        expect(body['longitude'], _pertoPreciso.longitude);
        expect(body['accuracyMeters'], 9.0);
        expect(body['source'], 'TECHNICIAN_GPS');
        expect(body['expectedVersion'], isNull, reason: 'criação do ponto');

        expect(find.text('Confirmada'), findsOneWidget);
        expect(find.text('Sem localização'), findsNothing);
        expect(h.captura.listening, isFalse);
      },
    );

    testWidgets(
      'GPS ruim + endereço + GPS ligado: NADA é enviado — nem como correção só de endereço — e a folha fica com o que foi digitado',
      (tester) async {
        final h = await abrir(
          tester,
          captura: FakePositionSource(
            script: const [ScriptedReading(-23.5505, -46.6333, accuracy: 300)],
          ),
        );
        await abrirFolha(tester);
        await tester.enterText(
          find.widgetWithText(TextField, 'Logradouro'),
          'Rua Digitada QA',
        );
        await tester.tap(find.byKey(const Key('correct-location-submit')));
        await buscando(tester);
        expect(find.text('Precisão atual: 300 m'), findsOneWidget);
        await esgotarCaptura(tester);
        expect(find.text('Precisão do GPS insuficiente'), findsOneWidget);

        await tester.tap(find.byKey(const Key('fix-close')));
        await settle(tester);
        expect(_posts(h.harness, 'correct'), 0);
        // A folha continua aberta, com o endereço digitado: dá para tentar de
        // novo ou desligar o GPS — a escolha é do técnico, não do app.
        expect(find.text('Corrigir endereço e localização'), findsOneWidget);
        expect(find.text('Rua Digitada QA'), findsOneWidget);
      },
    );

    testWidgets('GPS desligado: corrige só o endereço, sem abrir o GPS', (
      tester,
    ) async {
      final h = await abrir(tester);
      h.harness.transport.onJson(
        'POST',
        '/service-orders/os-1/location/correct',
        data: {},
      );
      await abrirFolha(tester);
      await tester.tap(find.byType(SwitchListTile));
      await tester.pump();
      await tester.enterText(find.widgetWithText(TextField, 'Número'), '77');
      await tester.tap(find.byKey(const Key('correct-location-submit')));
      await settle(tester);

      final body =
          h.harness.transport
                  .requestFor('POST', '/service-orders/os-1/location/correct')
                  .data
              as Map<String, dynamic>;
      expect(body.containsKey('latitude'), isFalse);
      expect(body.containsKey('accuracyMeters'), isFalse);
      expect(body.containsKey('source'), isFalse);
      expect(body['address'], {'number': '77'});
      expect(h.captura.watchCalls, 0);
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

    /*
      # O selo da seção Fotos (decisão do dono, 20/09/2026)

      O dono pediu confirmação VISÍVEL de que a foto subiu. O que estes casos
      fixam é a diferença entre os dois verdes:

      - "Concluído" afirma que a POLÍTICA foi cumprida;
      - "Registrado" afirma que o dado chegou ao SERVIDOR.

      A segunda é a que faltava, e ela não pode virar a primeira: uma foto
      gravada numa OS que exige três não cumpre nada.

      O selo é procurado no CABEÇALHO da seção, e isso importa: cada foto já
      persistida desenha o próprio `check_circle` na lista: um finder que
      apanhasse o cartão inteiro passaria mesmo com o cabeçalho sem selo
      nenhum.
    */
    testWidgets('FOTO-UI-01 · opcional e sem foto: nenhum selo', (
      tester,
    ) async {
      await abrir(tester);

      expect(_seloDeFotos(Icons.check_circle), findsNothing);
      expect(_seloDeFotos(Icons.error_outline), findsNothing);
    });

    testWidgets(
      'FOTO-UI-02 · opcional com foto do servidor: verde REGISTRADO',
      (tester) async {
        await abrir(
          tester,
          payload: bundle(evidences: [_evidenciaPersistida()]),
        );

        expect(_seloDeFotos(Icons.error_outline), findsNothing);
        final selo = tester.widget<Icon>(_seloDeFotos(Icons.check_circle));
        // A palavra é o contrato: "Registrado", nunca "Concluído" — nada foi
        // exigido aqui.
        expect(selo.semanticLabel, 'Registrado');
      },
    );

    testWidgets('FOTO-UI-03 · exigido e insuficiente: âmbar, mesmo com foto', (
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
            'minEvidenceCount': 3,
            'requiredEvidenceCategories': <String>[],
          },
          evidences: [_evidenciaPersistida()],
          pendencies: const [
            {
              'code': 'EVIDENCE_COUNT_BELOW_MINIMUM',
              'message': 'Anexe pelo menos 3 fotos.',
            },
          ],
        ),
      );

      expect(_seloDeFotos(Icons.check_circle), findsNothing);
      final selo = tester.widget<Icon>(_seloDeFotos(Icons.error_outline));
      expect(selo.semanticLabel, 'Pendente');
    });

    testWidgets('FOTO-UI-04 · exigido e satisfeito: verde CONCLUÍDO', (
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
            'minEvidenceCount': 1,
            'requiredEvidenceCategories': <String>[],
          },
          evidences: [_evidenciaPersistida()],
        ),
      );

      expect(_seloDeFotos(Icons.error_outline), findsNothing);
      final selo = tester.widget<Icon>(_seloDeFotos(Icons.check_circle));
      expect(selo.semanticLabel, 'Concluído');
    });

    testWidgets('FOTO-UI-05 · foto que FALHOU no envio não pinta verde', (
      tester,
    ) async {
      /*
        O caso que o §12 proíbe: verde otimista.

        Aqui a foto é tirada de verdade e o upload é RECUSADO pelo servidor.
        Ela continua na tela, guardada no aparelho e com o aviso de que não
        foi enviada (§58) — e é exatamente por isso que o cabeçalho não pode
        dizer que está tudo certo. `evidences` vem do servidor, e o servidor
        não tem nada.
      */
      final h = await abrir(tester, photo: _arquivoDeFoto());
      h.harness.transport.onJson(
        'POST',
        '/service-orders/os-1/evidence',
        status: 500,
        data: const {'code': 'INTERNAL', 'message': 'Falha ao gravar.'},
      );

      await tester.tap(find.text('ADICIONAR FOTO'));
      await settle(tester);
      // O envio lê um arquivo REAL: I/O não avança sob o relógio falso do
      // `flutter_test`, e sem `runAsync` o teste pendura em vez de falhar.
      await _enviarFoto(tester);

      // A foto ficou visível e honesta sobre o próprio estado...
      expect(find.textContaining('não enviada'), findsOneWidget);
      // ...e o cabeçalho não promete nada.
      expect(_seloDeFotos(Icons.check_circle), findsNothing);
    });

    testWidgets('FOTO-UI-06 · a MESMA foto, agora aceita, pinta o verde', (
      tester,
    ) async {
      /*
        Controle positivo do caso anterior, e não repetição dele: sem este, o
        `findsNothing` do FOTO-UI-05 passaria numa tela que nunca desenha
        selo nenhum. O que muda entre os dois é UMA coisa — a resposta do
        servidor ao upload.
      */
      final h = await abrir(tester, photo: _arquivoDeFoto());
      h.harness.transport.onJson(
        'POST',
        '/service-orders/os-1/evidence',
        status: 201,
        data: {'evidence': _evidenciaPersistida()},
      );
      // A releitura pós-sucesso: agora o servidor TEM a foto.
      h.harness.transport.onJson(
        'GET',
        '/service-orders/os-1/execution',
        data: bundle(evidences: [_evidenciaPersistida()], version: 4),
      );

      await tester.tap(find.text('ADICIONAR FOTO'));
      await settle(tester);
      await _enviarFoto(tester);

      expect(find.textContaining('não enviada'), findsNothing);
      final selo = tester.widget<Icon>(_seloDeFotos(Icons.check_circle));
      expect(selo.semanticLabel, 'Registrado');
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

/// Uma evidência já PERSISTIDA, como o servidor a devolve no pacote.
///
/// O pacote traz só evidência `COMMITTED` (`src/lib/field/execution.ts`): a
/// etiqueta temporária e a foto em upload não chegam aqui.
Map<String, dynamic> _evidenciaPersistida({String id = 'ev-1'}) => {
  'id': id,
  'category': 'OTHER',
  'caption': null,
  'createdAt': '2026-09-20T12:00:00.000Z',
};

/// O selo do CABEÇALHO da seção "Fotos", e só o dele.
///
/// Cada foto persistida desenha um `check_circle` próprio na lista, então o
/// finder precisa parar na `Row` do título. Buscar pelo ícone dentro do
/// cartão inteiro encontraria as fotos e passaria com o cabeçalho vazio.
Finder _seloDeFotos(IconData icone) => find.descendant(
  of: find.ancestor(of: find.text('Fotos'), matching: find.byType(Row)).first,
  matching: find.byIcon(icone),
);

/// Um arquivo de foto REAL no disco.
///
/// Precisa ser real: o repositório lê os bytes para montar o multipart, e um
/// caminho inexistente pendura o envio em vez de falhar com mensagem.
File _arquivoDeFoto() {
  final dir = Directory.systemTemp.createTempSync('alfaos-foto-');
  addTearDown(() => dir.deleteSync(recursive: true));
  return File('${dir.path}/foto.png')
    ..writeAsBytesSync(<int>[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

/// Escolhe a categoria e espera o upload REAL terminar.
///
/// Duas razões para não ser `settle`:
///
/// 1. o envio lê um arquivo de verdade, e I/O não avança sob o relógio falso
///    do `flutter_test` — daí o `runAsync`;
/// 2. enquanto a foto está subindo, a linha dela mostra um
///    `CircularProgressIndicator`, que é animação infinita:
///    `pumpAndSettle` estoura por tempo em vez de dizer o que houve.
Future<void> _enviarFoto(WidgetTester tester) async {
  // A PRIMEIRA categoria da folha: 'Outra' é a última de treze e fica fora da
  // área visível do bottom sheet, onde o toque não chega.
  await tester.tap(find.text('Antes do serviço'));

  /*
    Tempo real e quadros falsos, INTERCALADOS — e isso não é tentativa e erro.

    O envio lê um arquivo do disco para montar o multipart, e o transporte
    falso drena esse mesmo fluxo: são duas operações de I/O de verdade, que
    não avançam sob o relógio do `flutter_test`. Só `runAsync` as deixa
    correr. Mas a continuação delas é agendada na zona FALSA, e quem a executa
    é o `pump`. Uma volta só de cada não basta: a requisição sai e a resposta
    fica pelo caminho, com a linha da foto parada em "Enviando...".

    `pumpAndSettle` não serve aqui: a foto em upload mostra um
    `CircularProgressIndicator`, e animação infinita o faz estourar por tempo
    sem dizer o que houve.
  */
  for (var volta = 0; volta < 8; volta++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 120)),
    );
    for (var i = 0; i < 3; i++) {
      await tester.pump(const Duration(milliseconds: 60));
    }
  }
}
