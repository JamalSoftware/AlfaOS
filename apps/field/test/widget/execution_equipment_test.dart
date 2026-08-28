import 'dart:io';

import 'package:alfaos_field/app/providers.dart';
import 'package:alfaos_field/core/media/photo_capture.dart';
import 'package:alfaos_field/core/location/location_service.dart';
import 'package:alfaos_field/features/execution/ui/execution_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/harness.dart';

/// # Registro de equipamento — persistência e recusa
///
/// Regressão do segundo defeito do smoke test físico da v0.10. O servidor
/// registrou:
///
/// ```text
/// POST .../equipment 400
/// POST .../equipment 200
/// ```
///
/// e o técnico relatou que o formulário fechava sem o equipamento aparecer.
///
/// A investigação provou, pelas rotas reais contra Postgres
/// (`src/tests/field-equipment-persistence.test.ts`), que o backend estava
/// certo: o POST válido persiste, gera um evento e uma auditoria, e o bundle
/// devolve o equipamento uma vez. O defeito era do aplicativo, em três partes:
///
/// 1. **REGISTRAR ficava habilitado sem série e sem MAC** — o servidor exige
///    um dos dois, então o aplicativo mandava um comando fadado ao 400;
/// 2. **a folha fechava no toque, antes da resposta** — a recusa chegava com o
///    formulário já destruído e o que foi digitado perdido;
/// 3. **a mensagem ia para um banner no topo da página** — e a seção de
///    equipamentos fica no fim de uma `ListView` longa, então ela aparecia
///    fora da tela.
///
/// Do lado do técnico as três somavam "registrei e sumiu".
///
/// Fixtures fictícias: nenhum nome, endereço ou identificador real.

class _FakeGps implements LocationService {
  @override
  Future<LocationReading> current() async => const LocationReading.ok(
    DeviceLocation(latitude: -23.55, longitude: -46.63, accuracyMeters: 9),
  );
}

/// Câmera falsa que devolve um arquivo REAL.
///
/// Precisa ser real: o repositório lê os bytes para montar o multipart, e um
/// caminho inexistente pendura o envio em vez de falhar com mensagem.
class _FakeCamera implements PhotoCapture {
  _FakeCamera(this.file);

  File? file;
  int chamadas = 0;

  @override
  Future<File?> takePhoto() async {
    chamadas += 1;
    return file;
  }

  @override
  Future<File?> pickFromGallery() async {
    chamadas += 1;
    return file;
  }
}

File _arquivoDeFoto() {
  final dir = Directory.systemTemp.createTempSync('alfaos-etiqueta-');
  addTearDown(() => dir.deleteSync(recursive: true));
  final file = File('${dir.path}/etiqueta.png')
    ..writeAsBytesSync(<int>[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return file;
}

const _rotaEvidencia = '/service-orders/os-1/evidence';

/// Como o servidor responde ao upload da etiqueta.
Map<String, dynamic> _evidenciaCriada(String id) => {
  'evidence': {
    'id': id,
    'category': 'EQUIPMENT_LABEL',
    'caption': null,
    'mimeType': 'image/png',
    'sizeBytes': 8,
    'createdAt': '2026-08-28T12:00:00.000Z',
  },
};

const _equipamentoDoServidor = {
  'id': 'eq-1',
  'equipmentType': 'ONU',
  'manufacturer': 'Fabricante Ficticio',
  'model': 'MODELO-X',
  // Propositalmente DIFERENTE do que o teste digita: é o que distingue
  // "veio do servidor" de "a tela mostrou o que eu mesmo escrevi".
  'serial': 'SERIAL-DO-SERVIDOR',
  'macAddress': null,
};

Map<String, dynamic> _bundle({
  List<Map<String, dynamic>> equipments = const [],
  int version = 3,
}) {
  return {
    'orderId': 'os-1',
    'version': version,
    'executionVersion': 1,
    'report': {
      'diagnosis': 'Conector com atenuação.',
      'workPerformed': 'Conector refeito.',
      'notes': null,
    },
    'location': {
      'status': 'UNCONFIRMED',
      'latitude': -23.55,
      'longitude': -46.63,
      'accuracyMeters': null,
      'source': 'IMPORTED',
      'verified': false,
      'reference': null,
      'version': 0,
    },
    'checkIn': null,
    'checklist': const [],
    'evidences': const [],
    'materials': const [],
    'equipments': equipments,
    'signature': null,
    'contactAttempts': const [],
    'impediments': const [],
    'requirements': const {
      'requireChecklist': false,
      'requireSignature': false,
      'requireMaterials': false,
      'requireEquipment': false,
      'requireCheckIn': false,
      'minEvidenceCount': 0,
      'requiredEvidenceCategories': <String>[],
    },
    'pendencies': const [],
  };
}

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 60));
  }
  await tester.pumpAndSettle(const Duration(milliseconds: 50));
}

Future<Harness> _abrirTela(WidgetTester tester) async {
  tester.view.physicalSize = const Size(1200, 5000);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);

  final harness = Harness();
  harness.transport.onJson(
    'GET',
    '/service-orders/os-1/execution',
    data: _bundle(),
  );
  harness.transport.onJson('GET', '/inventory', data: {'items': <dynamic>[]});

  // A etiqueta é obrigatória desde a v0.10.1: toda folha de equipamento passa
  // por uma captura antes de o botão Registrar existir.
  harness.transport.onJson(
    'POST',
    _rotaEvidencia,
    status: 201,
    data: _evidenciaCriada('etiqueta-1'),
  );

  await harness.pump(
    tester,
    const ExecutionScreen(orderId: 'os-1'),
    extraOverrides: [
      locationServiceProvider.overrideWithValue(_FakeGps()),
      photoCaptureProvider.overrideWithValue(_FakeCamera(_arquivoDeFoto())),
    ],
  );
  await _settle(tester);
  return harness;
}

Finder _campo(String label) =>
    find.ancestor(of: find.text(label), matching: find.byType(TextField));

const _submit = Key('equipment-submit');
const _rota = '/service-orders/os-1/equipment';

/// Abre a folha e preenche o mínimo que o servidor aceita.
///
/// O mínimo mudou na v0.10.1: é a FOTO DA ETIQUETA, não o texto. Série e MAC
/// continuam aceitos porque digitar às vezes é mais rápido que enquadrar.
Future<void> _preencher(
  WidgetTester tester, {
  String serial = 'FICT001',
}) async {
  await tester.tap(find.text('Registrar equipamento'));
  await _settle(tester);
  await tester.enterText(_campo('Fabricante'), 'Fabricante Ficticio');
  await tester.enterText(_campo('Modelo'), 'MODELO-X');
  if (serial.isNotEmpty) {
    await tester.enterText(_campo('Número de série (opcional)'), serial);
  }
  await _settle(tester);
  await _fotografarEtiqueta(tester);
}

/// Captura a etiqueta — dentro de `runAsync`, e isso não é estilo.
///
/// O envio monta um multipart a partir de um arquivo REAL, e I/O de verdade
/// não avança sob o relógio falso do `flutter_test`: `pump` não roda o event
/// loop do `dart:io`. Sem `runAsync` a captura fica pendurada para sempre e o
/// `pumpAndSettle` estoura no indicador de progresso — sem dizer por quê.
Future<void> _fotografarEtiqueta(WidgetTester tester) async {
  await tester.runAsync(() async {
    await tester.tap(find.text('FOTOGRAFAR ETIQUETA'));
    await Future<void>.delayed(const Duration(milliseconds: 300));
  });
  await _settle(tester);
}

void main() {
  testWidgets('REGISTRAR envia UM comando e o equipamento vem do SERVIDOR', (
    tester,
  ) async {
    final harness = await _abrirTela(tester);
    harness.transport.onJson('POST', _rota);
    await _preencher(tester);

    // A releitura pós-sucesso é o que o servidor devolveria.
    harness.transport.onJson(
      'GET',
      '/service-orders/os-1/execution',
      data: _bundle(equipments: const [_equipamentoDoServidor], version: 4),
    );

    await tester.tap(find.byKey(_submit));
    await _settle(tester);

    expect(tester.takeException(), isNull);
    expect(harness.transport.countOf('POST', _rota), 1);
    expect(find.text('Equipamento instalado'), findsNothing);

    /*
      A tela mostra o SERIAL DO SERVIDOR, não o que foi digitado.

      É o que separa persistência real de UI otimista: se a lista fosse
      montada com o que o formulário tinha na mão, ela mostraria "FICT001" e
      continuaria mostrando mesmo que o servidor nunca tivesse gravado nada.
    */
    expect(find.textContaining('SERIAL-DO-SERVIDOR'), findsOneWidget);
    expect(find.textContaining('FICT001'), findsNothing);
  });

  testWidgets('o corpo enviado é o que foi digitado', (tester) async {
    final harness = await _abrirTela(tester);
    harness.transport.onJson('POST', _rota);
    await _preencher(tester, serial: 'FICT002');

    await tester.tap(find.byKey(_submit));
    await _settle(tester);

    final body =
        harness.transport.requestFor('POST', _rota).data
            as Map<String, dynamic>;
    expect(body['equipmentType'], 'ONU');
    expect(body['manufacturer'], 'Fabricante Ficticio');
    expect(body['model'], 'MODELO-X');
    expect(body['serial'], 'FICT002');
    expect(body['expectedVersion'], 3);
    // CAS e idempotência viajam juntas e respondem perguntas diferentes.
    expect(
      harness.transport.requestFor('POST', _rota).headers['Idempotency-Key'],
      isNotNull,
    );
  });

  group('recusa do servidor', () {
    testWidgets('400 NÃO fecha a folha, mostra o motivo e preserva o que foi '
        'digitado', (tester) async {
      final harness = await _abrirTela(tester);
      harness.transport.onError(
        'POST',
        _rota,
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Informe ao menos o número de série ou o endereço MAC.',
      );
      await _preencher(tester, serial: 'FICT003');

      await tester.tap(find.byKey(_submit));
      await _settle(tester);

      expect(tester.takeException(), isNull);
      // Continua aberta.
      expect(find.text('Equipamento instalado'), findsOneWidget);
      // Com o motivo à vista, dentro da folha — não num banner fora da tela.
      expect(
        find.text('Informe ao menos o número de série ou o endereço MAC.'),
        findsOneWidget,
      );
      // E sem perder nada do que o técnico digitou.
      expect(find.text('Fabricante Ficticio'), findsOneWidget);
      expect(find.text('MODELO-X'), findsOneWidget);
      expect(find.text('FICT003'), findsOneWidget);
    });

    testWidgets('depois do 400 dá para corrigir e reenviar, sem redigitar', (
      tester,
    ) async {
      final harness = await _abrirTela(tester);
      harness.transport.onError(
        'POST',
        _rota,
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Endereço MAC inválido.',
      );
      await _preencher(tester, serial: 'FICT004');

      await tester.tap(find.byKey(_submit));
      await _settle(tester);
      expect(find.text('Equipamento instalado'), findsOneWidget);

      // O servidor passa a aceitar; o técnico só toca de novo.
      harness.transport.onJson('POST', _rota);
      harness.transport.onJson(
        'GET',
        '/service-orders/os-1/execution',
        data: _bundle(equipments: const [_equipamentoDoServidor], version: 4),
      );

      await tester.tap(find.byKey(_submit));
      await _settle(tester);

      expect(find.text('Equipamento instalado'), findsNothing);
      expect(harness.transport.countOf('POST', _rota), 2);
      expect(find.textContaining('SERIAL-DO-SERVIDOR'), findsOneWidget);
    });

    testWidgets('SEM a foto da etiqueta o botão nem habilita', (tester) async {
      final harness = await _abrirTela(tester);
      harness.transport.onJson('POST', _rota);

      await tester.tap(find.text('Registrar equipamento'));
      await _settle(tester);
      await tester.enterText(_campo('Fabricante'), 'Fabricante Ficticio');
      await tester.enterText(_campo('Número de série (opcional)'), 'FICT009');
      await _settle(tester);

      /*
        Série digitada NÃO libera mais o botão (v0.10.1).

        A identificação passou a ser a foto: um equipamento sem etiqueta não
        tem como ser conferido depois, mesmo com série no campo — foi
        justamente a transcrição manual que a mudança veio remover.
      */
      expect(
        tester.widget<FilledButton>(find.byKey(_submit)).onPressed,
        isNull,
      );
      await tester.tap(find.byKey(_submit));
      await _settle(tester);
      expect(harness.transport.countOf('POST', _rota), 0);

      await _fotografarEtiqueta(tester);

      expect(harness.transport.countOf('POST', _rotaEvidencia), 1);
      expect(find.text('Etiqueta anexada'), findsOneWidget);
      expect(
        tester.widget<FilledButton>(find.byKey(_submit)).onPressed,
        isNotNull,
      );
    });

    testWidgets('SÓ a foto, sem digitar série nem MAC, já registra', (
      tester,
    ) async {
      final harness = await _abrirTela(tester);
      harness.transport.onJson('POST', _rota);

      await tester.tap(find.text('Registrar equipamento'));
      await _settle(tester);
      await _fotografarEtiqueta(tester);

      await tester.tap(find.byKey(_submit));
      await _settle(tester);

      expect(tester.takeException(), isNull);
      expect(harness.transport.countOf('POST', _rota), 1);

      /*
        O objetivo de produto, medido no corpo da requisição.

        O técnico não digitou identificador nenhum: o comando sai com série e
        MAC vazios e com o id da etiqueta. É isso que troca doze caracteres
        transcritos agachado dentro de um armário por uma foto.
      */
      final body =
          harness.transport.requestFor('POST', _rota).data
              as Map<String, dynamic>;
      // AUSENTES, não vazios: o repositório omite o campo que ninguém
      // preencheu, para o servidor distinguir "não informou" de "informou
      // vazio". A identificação vai no lugar deles.
      expect(body.containsKey('serial'), isFalse);
      expect(body.containsKey('macAddress'), isFalse);
      expect(body['labelEvidenceId'], 'etiqueta-1');
    });

    testWidgets('MAC vazio não vira "MAC inválido"', (tester) async {
      final harness = await _abrirTela(tester);
      harness.transport.onJson('POST', _rota);

      await _preencher(tester, serial: '');
      await tester.tap(find.byKey(_submit));
      await _settle(tester);

      // Campo vazio é ausência, não formato errado: o comando sai, e nenhuma
      // validação local o barra.
      expect(harness.transport.countOf('POST', _rota), 1);
      expect(find.text('Endereço MAC inválido'), findsNothing);
    });

    testWidgets('409 mantém a folha aberta para tentar com a versão nova', (
      tester,
    ) async {
      final harness = await _abrirTela(tester);
      harness.transport.onError(
        'POST',
        _rota,
        status: 409,
        code: 'VERSION_CONFLICT',
        message: 'A OS mudou.',
        conflict: true,
      );
      await _preencher(tester, serial: 'FICT005');

      await tester.tap(find.byKey(_submit));
      await _settle(tester);

      expect(tester.takeException(), isNull);
      expect(find.text('Equipamento instalado'), findsOneWidget);
      expect(find.text('FICT005'), findsOneWidget);
    });
  });

  testWidgets('duplo toque durante o envio não duplica o comando', (
    tester,
  ) async {
    final harness = await _abrirTela(tester);
    // Resposta lenta: sem janela não há duplo toque a testar.
    harness.transport.onJson(
      'POST',
      _rota,
      delay: const Duration(milliseconds: 400),
    );
    await _preencher(tester, serial: 'FICT006');

    await tester.tap(find.byKey(_submit));
    await tester.pump(const Duration(milliseconds: 50));
    // Segundo toque com o comando ainda em voo.
    await tester.tap(find.byKey(_submit), warnIfMissed: false);
    await _settle(tester);

    expect(harness.transport.countOf('POST', _rota), 1);
  });

  testWidgets('recarregar a página mantém o equipamento', (tester) async {
    final harness = await _abrirTela(tester);
    harness.transport.onJson('POST', _rota);
    await _preencher(tester, serial: 'FICT007');
    harness.transport.onJson(
      'GET',
      '/service-orders/os-1/execution',
      data: _bundle(equipments: const [_equipamentoDoServidor], version: 4),
    );

    await tester.tap(find.byKey(_submit));
    await _settle(tester);
    expect(find.textContaining('SERIAL-DO-SERVIDOR'), findsOneWidget);

    // Pull-to-refresh: a tela relê tudo do servidor.
    await tester.fling(
      find.byType(RefreshIndicator),
      const Offset(0, 400),
      1000,
    );
    await _settle(tester);

    expect(tester.takeException(), isNull);
    expect(find.textContaining('SERIAL-DO-SERVIDOR'), findsOneWidget);
  });

  testWidgets('a tela reaberta mostra o que o servidor tem', (tester) async {
    /*
      Reabrir é um MONTE NOVO: controlador novo, estado novo, nada em memória.

      É o que separa persistência de UI otimista no cliente. A prova de que o
      dado realmente ficou no banco está no teste de backend, pela rota real —
      aqui o que se afirma é que a tela nasce a partir do servidor.
    */
    tester.view.physicalSize = const Size(1200, 5000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final harness = Harness();
    harness.transport.onJson(
      'GET',
      '/service-orders/os-1/execution',
      data: _bundle(equipments: const [_equipamentoDoServidor], version: 4),
    );
    harness.transport.onJson('GET', '/inventory', data: {'items': <dynamic>[]});

    await harness.pump(
      tester,
      const ExecutionScreen(orderId: 'os-1'),
      extraOverrides: [locationServiceProvider.overrideWithValue(_FakeGps())],
    );
    await _settle(tester);

    expect(find.textContaining('SERIAL-DO-SERVIDOR'), findsOneWidget);
    expect(harness.transport.countOf('POST', _rota), 0);
  });

  testWidgets('o catálogo de estoque LENTO não apaga o equipamento', (
    tester,
  ) async {
    /*
      A corrida do §12, com janela real.

      `load()` e `loadStock()` correm juntos ao montar a tela. Se o `loadStock`
      montasse o novo estado sobre um `state` lido ANTES da ida à rede, ele
      devolveria o pacote velho — e o equipamento sumiria da tela sem nunca ter
      sumido do banco. O atraso de 300 ms garante que o estoque chegue depois
      do pacote, que é a ordem que expõe o defeito.
    */
    tester.view.physicalSize = const Size(1200, 5000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final harness = Harness();
    harness.transport.onJson(
      'GET',
      '/service-orders/os-1/execution',
      data: _bundle(equipments: const [_equipamentoDoServidor], version: 4),
    );
    harness.transport.onJson(
      'GET',
      '/inventory',
      data: {
        'items': [
          {
            'itemId': 'item-1',
            'sku': 'CAB-DROP',
            'name': 'Cabo drop',
            'unit': 'm',
            'balance': 300,
          },
        ],
      },
      delay: const Duration(milliseconds: 300),
    );

    await harness.pump(
      tester,
      const ExecutionScreen(orderId: 'os-1'),
      extraOverrides: [locationServiceProvider.overrideWithValue(_FakeGps())],
    );
    await _settle(tester);
    await tester.pump(const Duration(milliseconds: 400));
    await _settle(tester);

    expect(tester.takeException(), isNull);
    // O estoque chegou...
    expect(find.text('Registrar material'), findsOneWidget);
    // ...e não levou o equipamento embora.
    expect(find.textContaining('SERIAL-DO-SERVIDOR'), findsOneWidget);
  });
}
