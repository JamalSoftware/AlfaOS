import 'package:alfaos_field/app/providers.dart';
import 'package:alfaos_field/core/location/location_service.dart';
import 'package:alfaos_field/features/execution/ui/execution_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/harness.dart';

/// # Ciclo de vida dos formulários da execução
///
/// Regressão do defeito encontrado no smoke test físico da v0.10: abrir
/// "Equipamento instalado", digitar e apertar **VOLTAR** derrubava a tela com
///
/// > A TextEditingController was used after being disposed.
///
/// A causa não era o `TextField` nem o VOLTAR: era **posse**. Cada formulário
/// criava os `TextEditingController` na própria função, dava `await` na folha e
/// chamava `dispose()` logo em seguida. Só que `showModalBottomSheet` completa
/// o `Future` no instante do **pop**, e não no fim do fechamento — a folha
/// ainda toca a animação de saída, e quando o `EditableText` dela é finalmente
/// desmontado ele chama `removeListener` no controlador. Que já estava morto.
///
/// Pelo botão de confirmar quase nunca aparecia, porque o `await` da chamada de
/// rede dava tempo de a animação terminar antes do `dispose()`. Pelo VOLTAR
/// não havia esse intervalo.
///
/// Estes testes seguram as duas metades:
///
/// * **nenhuma exceção** ao fechar por qualquer via — `tester.takeException()`;
/// * **nada persiste** quando não houve registro — nenhum POST sai.
///
/// Fixtures fictícias: nenhum nome, endereço ou identificador real.

/// GPS falso. A tela pede posição ao montar; sem isto o teste dependeria de
/// canal de plataforma que não existe aqui.
class _FakeGps implements LocationService {
  @override
  Future<LocationReading> current() async => const LocationReading.ok(
    DeviceLocation(latitude: -23.55, longitude: -46.63, accuracyMeters: 9),
  );
}

Map<String, dynamic> _bundle({
  List<Map<String, dynamic>> equipments = const [],
  List<Map<String, dynamic>> checklist = const [],
}) {
  return {
    'orderId': 'os-1',
    'version': 3,
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
    'checklist': checklist,
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

const _estoque = [
  {
    'itemId': 'item-1',
    'sku': 'CAB-DROP',
    'name': 'Cabo drop',
    'unit': 'm',
    'balance': 300,
  },
];

const _checklistItem = {
  'id': 'chk-1',
  'code': 'POTENCIA',
  'label': 'Potência na ONU',
  'description': null,
  'type': 'TEXT',
  'required': true,
  'options': <String>[],
  'answered': false,
  'valueBoolean': null,
  'valueText': null,
  'valueNumber': null,
  'evidenceCategory': null,
};

/// Dá frames para a rede em voo ANTES de assentar (mesmo motivo de
/// `execution_test.dart`: `pumpAndSettle` sozinho volta com o carregamento
/// ainda pendente).
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 60));
  }
  await tester.pumpAndSettle(const Duration(milliseconds: 50));
}

/// O **VOLTAR do Android**, não um `Navigator.pop` de conveniência.
///
/// `handlePopRoute` é o mesmo canal que o sistema usa no botão físico — que é
/// exatamente o caminho onde o defeito aparecia. Fechar por `pop()` direto no
/// teste passaria por cima da coisa que se quer provar.
Future<void> _voltar(WidgetTester tester) async {
  await tester.binding.handlePopRoute();
  await _settle(tester);
}

Future<Harness> _abrirTela(
  WidgetTester tester, {
  Map<String, dynamic>? payload,
  List<Map<String, dynamic>> stock = const [],
}) async {
  // Viewport alto: a tela é uma `ListView` e as seções abaixo da dobra não
  // seriam sequer construídas numa janela de 800×600.
  tester.view.physicalSize = const Size(1200, 5000);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);

  final harness = Harness();
  harness.transport.onJson(
    'GET',
    '/service-orders/os-1/execution',
    data: payload ?? _bundle(),
  );
  harness.transport.onJson('GET', '/inventory', data: {'items': stock});

  await harness.pump(
    tester,
    const ExecutionScreen(orderId: 'os-1'),
    extraOverrides: [locationServiceProvider.overrideWithValue(_FakeGps())],
  );
  await _settle(tester);
  return harness;
}

/// Campo pelo rótulo — não por índice.
///
/// Índice quebra em silêncio quando um campo é inserido no meio do formulário,
/// e o teste continua verde digitando no lugar errado.
Finder _campo(String label) =>
    find.ancestor(of: find.text(label), matching: find.byType(TextField));

void main() {
  group('equipamento — o caso que o smoke test encontrou', () {
    testWidgets('VOLTAR com o formulário PREENCHIDO PELA METADE não estoura', (
      tester,
    ) async {
      final harness = await _abrirTela(tester);

      await tester.tap(find.text('Registrar equipamento'));
      await _settle(tester);
      expect(find.text('Equipamento instalado'), findsOneWidget);

      // Metade preenchida: é como o técnico estava quando a tela caiu.
      await tester.enterText(_campo('Fabricante'), 'Huawei');
      await tester.enterText(_campo('Número de série'), 'ABC123456');
      await _settle(tester);

      await _voltar(tester);

      // O ASSERT do defeito. Sem a correção, aqui vem
      // "A TextEditingController was used after being disposed."
      expect(tester.takeException(), isNull);
      expect(find.text('Equipamento instalado'), findsNothing);
      // E a cena exata do smoke test também não pode ter escrito nada.
      expect(
        harness.transport.requests.where((r) => r.method != 'GET'),
        isEmpty,
      );
    });

    testWidgets('VOLTAR com o formulário VAZIO — apenas TOCADO — não estoura', (
      tester,
    ) async {
      await _abrirTela(tester);

      await tester.tap(find.text('Registrar equipamento'));
      await _settle(tester);

      /*
        O toque no campo NÃO é enfeite.

        Abrir e fechar sem encostar em nada sobrevivia até ao ciclo de vida
        defeituoso — sem foco, o cursor nunca reassina o controlador, e a
        animação de saída não chega a tocar no objeto morto. Provado: sob a
        sabotagem, esta mesma cena SEM o toque passava.

        O foco é o que traz o `AnimatedBuilder` do cursor para dentro da
        animação de fechamento. É o mínimo necessário para o teste poder falhar
        pela razão que ele afirma — e é o que o técnico faz antes de desistir.
      */
      await tester.tap(_campo('Fabricante'));
      await _settle(tester);

      await _voltar(tester);

      expect(tester.takeException(), isNull);
      expect(find.text('Equipamento instalado'), findsNothing);
    });

    testWidgets('VOLTAR não persiste NADA — nenhum POST sai', (tester) async {
      final harness = await _abrirTela(tester);

      await tester.tap(find.text('Registrar equipamento'));
      await _settle(tester);
      await tester.enterText(_campo('Modelo'), 'EG8145V5');
      await tester.enterText(_campo('Número de série'), 'ABC123456');
      await _settle(tester);

      await _voltar(tester);

      /*
        Nenhum POST significa: nenhum Equipment, nenhum ServiceOrderEvent,
        nenhum AuditLog. A asserção é feita na FRONTEIRA HTTP de propósito —
        é o único ponto por onde o aplicativo poderia produzir qualquer um dos
        três, e não depende de conhecer o banco.
      */
      expect(
        harness.transport.countOf('POST', '/service-orders/os-1/equipment'),
        0,
      );
      expect(
        harness.transport.requests.where((r) => r.method != 'GET'),
        isEmpty,
        reason: 'cancelar não pode escrever nada em lugar nenhum',
      );
    });

    testWidgets('toque FORA da folha também só fecha, sem escrever', (
      tester,
    ) async {
      final harness = await _abrirTela(tester);

      await tester.tap(find.text('Registrar equipamento'));
      await _settle(tester);
      await tester.enterText(_campo('Fabricante'), 'Huawei');
      await _settle(tester);

      // A barreira modal fica no topo da tela, acima da folha.
      await tester.tapAt(const Offset(600, 10));
      await _settle(tester);

      expect(tester.takeException(), isNull);
      expect(find.text('Equipamento instalado'), findsNothing);
      expect(
        harness.transport.requests.where((r) => r.method != 'GET'),
        isEmpty,
      );
    });

    testWidgets('REGISTRAR envia o que foi digitado e cria UM equipamento', (
      tester,
    ) async {
      final harness = await _abrirTela(tester);
      harness.transport.onJson('POST', '/service-orders/os-1/equipment');

      await tester.tap(find.text('Registrar equipamento'));
      await _settle(tester);
      await tester.enterText(_campo('Fabricante'), 'Huawei');
      await tester.enterText(_campo('Modelo'), 'EG8145V5');
      await tester.enterText(_campo('Número de série'), 'ABC123456');
      await _settle(tester);

      // A releitura pós-registro traz o equipamento — como no servidor real.
      harness.transport.onJson(
        'GET',
        '/service-orders/os-1/execution',
        data: _bundle(
          equipments: [
            {
              'id': 'eq-1',
              'equipmentType': 'ONU',
              'manufacturer': 'Huawei',
              'model': 'EG8145V5',
              'serial': 'ABC123456',
              'macAddress': null,
              'notes': null,
              'installedAt': '2026-08-28T12:00:00.000Z',
            },
          ],
        ),
      );

      await tester.tap(find.byKey(const Key('equipment-submit')));
      await _settle(tester);

      expect(tester.takeException(), isNull);
      expect(
        harness.transport.countOf('POST', '/service-orders/os-1/equipment'),
        1,
      );

      /*
        O corpo prova que a POSSE funcionou.

        Se os controladores morressem cedo demais, o caminho de sucesso ou
        estouraria ou enviaria vazio. Ler o que chegou ao transporte é o que
        distingue "não quebrou" de "levou o dado certo".
      */
      final body =
          harness.transport
                  .requestFor('POST', '/service-orders/os-1/equipment')
                  .data
              as Map<String, dynamic>;
      expect(body['equipmentType'], 'ONU');
      expect(body['manufacturer'], 'Huawei');
      expect(body['model'], 'EG8145V5');
      expect(body['serial'], 'ABC123456');

      // E aparece UMA vez na lista — não duas.
      expect(find.textContaining('ABC123456'), findsOneWidget);
    });

    testWidgets('REGISTRAR e VOLTAR imediatamente não estoura nem duplica', (
      tester,
    ) async {
      final harness = await _abrirTela(tester);
      harness.transport.onJson('POST', '/service-orders/os-1/equipment');

      await tester.tap(find.text('Registrar equipamento'));
      await _settle(tester);
      await tester.enterText(_campo('Número de série'), 'ABC123456');
      await _settle(tester);

      await tester.tap(find.byKey(const Key('equipment-submit')));
      // UM frame apenas: a folha já deu pop, mas a animação de saída está no
      // meio — a janela exata em que o código antigo destruía os controladores.
      await tester.pump();
      await tester.binding.handlePopRoute();
      await _settle(tester);

      expect(tester.takeException(), isNull);
      expect(
        harness.transport.countOf('POST', '/service-orders/os-1/equipment'),
        1,
      );
    });

    testWidgets('abrir e fechar CINCO vezes seguidas não vaza nem estoura', (
      tester,
    ) async {
      final harness = await _abrirTela(tester);

      for (var i = 0; i < 5; i++) {
        await tester.tap(find.text('Registrar equipamento'));
        await _settle(tester);
        expect(find.text('Equipamento instalado'), findsOneWidget);

        await tester.enterText(_campo('Fabricante'), 'Fabricante $i');
        await _settle(tester);

        await _voltar(tester);
        expect(
          tester.takeException(),
          isNull,
          reason: 'ciclo $i deixou exceção pendente',
        );
        expect(find.text('Equipamento instalado'), findsNothing);
      }

      expect(
        harness.transport.requests.where((r) => r.method != 'GET'),
        isEmpty,
      );
    });
  });

  group('o mesmo padrão em TODAS as folhas', () {
    /*
      A varredura é o que impede o conserto pontual.

      O defeito não era do formulário de equipamento: era do jeito como TODOS
      eles possuíam seus controladores. Um teste por folha, com o mesmo VOLTAR,
      é o que garante que a próxima folha escrita no mesmo molde velho falhe
      aqui — e não em campo.
    */
    final folhas = <({String abrir, String titulo, bool porTooltip})>[
      (abrir: 'Editar', titulo: 'Relatório do atendimento', porTooltip: false),
      (
        abrir: 'Corrigir',
        titulo: 'Corrigir endereço e localização',
        porTooltip: false,
      ),
      (abrir: 'Responder', titulo: 'Potência na ONU', porTooltip: true),
      (
        abrir: 'Registrar material',
        titulo: 'Registrar material',
        porTooltip: false,
      ),
      (
        abrir: 'Registrar equipamento',
        titulo: 'Equipamento instalado',
        porTooltip: false,
      ),
      (
        abrir: 'Tentativa de contato',
        titulo: 'Tentativa de contato',
        porTooltip: false,
      ),
      (
        abrir: 'Não consegui executar',
        titulo: 'Não consegui executar',
        porTooltip: false,
      ),
      (
        abrir: 'Coletar assinatura',
        titulo: 'Assinatura do cliente',
        porTooltip: false,
      ),
    ];

    for (final folha in folhas) {
      testWidgets('"${folha.abrir}" fecha no VOLTAR sem estourar', (
        tester,
      ) async {
        final harness = await _abrirTela(
          tester,
          payload: _bundle(checklist: const [_checklistItem]),
          stock: _estoque,
        );
        // O relatório é o único que salva ao fechar por qualquer via — decisão
        // de produto preservada, então a rota precisa existir.
        harness.transport.onJson('POST', '/service-orders/os-1/execution');

        final gatilho = folha.porTooltip
            ? find.byTooltip(folha.abrir)
            : find.widgetWithText(OutlinedButton, folha.abrir);
        await tester.tap(gatilho.first);
        await _settle(tester);
        expect(
          find.text(folha.titulo),
          findsWidgets,
          reason: 'a folha "${folha.abrir}" nem abriu',
        );

        /*
          DIGITAR antes de voltar é o que dá dentes à varredura.

          Abrir e fechar sem tocar em nada sobrevive ao ciclo de vida
          defeituoso: sem foco, o cursor não reassina o controlador durante a
          animação de saída. Verificado na prova de reversão — a varredura sem
          esta digitação passava com o formulário de equipamento quebrado, ou
          seja, não teria pegado o defeito que motivou tudo isto.

          Folha sem campo de texto (tentativa de contato) não possui
          controlador nenhum; para ela o teste é cobertura de que fecha limpo.
        */
        final campos = find.byType(TextField);
        if (campos.evaluate().isNotEmpty) {
          await tester.enterText(campos.first, 'texto de teste');
          await _settle(tester);
        }

        await _voltar(tester);

        expect(tester.takeException(), isNull);
      });
    }
  });
}
