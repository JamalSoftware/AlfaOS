import 'package:flutter_test/flutter_test.dart';

import 'package:alfaos_field/features/execution/domain/execution.dart';

/// # O selo de estado das seções da execução
///
/// O dono validou o §382 em aparelho real e apontou uma inconsistência: os
/// "Equipamentos instalados" não diziam se estavam pendentes ou concluídos,
/// enquanto outras seções exigidas diziam.
///
/// O que estes casos fixam não é o ícone — é a AUTORIDADE. O estado vem de
/// `requirements` (a política do tipo de OS) e de `pendencies` (o resultado de
/// `validateServiceOrderCompletion`), os dois já entregues pelo servidor no
/// pacote da execução. O aplicativo não decide o que é exigido.
///
/// O erro que estes testes existem para impedir é o atalho óbvio: "lista
/// vazia = pendente". Equipamento vazio numa OS que NÃO exige equipamento é um
/// atendimento correto, e pintá-lo de âmbar ensina o técnico a ignorar o aviso
/// justamente onde ele importa.

ExecutionBundle _bundle({
  Map<String, dynamic> requirements = const {},
  List<Map<String, dynamic>> pendencies = const [],
  List<Map<String, dynamic>> equipments = const [],
  List<Map<String, dynamic>> materials = const [],
  List<Map<String, dynamic>> evidences = const [],
}) {
  return ExecutionBundle.fromJson({
    'orderId': 'os-1',
    'version': 1,
    'report': {
      'diagnosis': 'Diagnóstico.',
      'workPerformed': 'Serviço.',
      'notes': null,
    },
    'location': {'status': 'CONFIRMED', 'verified': true, 'version': 1},
    'requirements': requirements,
    'pendencies': pendencies,
    'equipments': equipments,
    'materials': materials,
    'evidences': evidences,
  });
}

Map<String, dynamic> _foto({String id = 'ev-1', String categoria = 'OTHER'}) =>
    {
      'id': id,
      'category': categoria,
      'caption': null,
      'createdAt': '2026-09-20T12:00:00.000Z',
    };

Map<String, dynamic> _equipamento() => {
  'id': 'eq-1',
  'equipmentType': 'ONU',
  'model': 'XZ-1',
  'serial': 'ABC123',
  'macAddress': null,
};

void main() {
  group('EQUIP-UX — o selo de equipamento vem da política, não da lista', () {
    test('EQUIP-UX-01 · exigido e vazio → PENDENTE', () {
      final bundle = _bundle(requirements: {'requireEquipment': true});
      expect(bundle.equipmentStatus, SectionStatus.pending);
    });

    test('EQUIP-UX-02 · exigido e satisfeito → CONCLUÍDO', () {
      /*
        "Satisfeito" é a condição do SERVIDOR, letra por letra: em
        `validateServiceOrderCompletion`, `requireEquipment` com
        `count === 0` produz `EQUIPMENT_REQUIRED`. Uma linha basta — e é o
        fechamento que define isso, não esta tela.
      */
      final bundle = _bundle(
        requirements: {'requireEquipment': true},
        equipments: [_equipamento()],
      );
      expect(bundle.equipmentStatus, SectionStatus.done);
    });

    test('EQUIP-UX-03 · NÃO exigido e vazio → NEUTRO', () {
      final bundle = _bundle(requirements: {'requireEquipment': false});
      expect(bundle.equipmentStatus, SectionStatus.neutral);
    });

    test('EQUIP-UX-04 · não exigido COM equipamento continua neutro', () {
      // Registrar equipamento numa OS que não o exige é legítimo, e não
      // transforma a seção numa etapa de conclusão.
      final bundle = _bundle(
        requirements: {'requireEquipment': false},
        equipments: [_equipamento()],
      );
      expect(bundle.equipmentStatus, SectionStatus.neutral);
    });

    test('EQUIP-UX-05 · sem requirements no pacote, nada é exigido', () {
      // Pacote de servidor antigo, ou tipo de OS sem política: a ausência de
      // política significa "não exige", que é o que o backend faz
      // (`if (!policy) return pendencies`). Inventar exigência aqui
      // bloquearia visualmente uma OS que fecha sem nada disso.
      expect(_bundle().equipmentStatus, SectionStatus.neutral);
    });
  });

  /*
    O dono pediu confirmação visível de que a FOTO subiu.

    O que está em jogo é a diferença entre "a exigência foi cumprida" e "isto
    foi gravado". Uma foto opcional nunca cumpre exigência nenhuma — e ainda
    assim o técnico precisa saber que ela chegou, porque ele está no telhado e
    não vai conferir depois.
  */
  group('FOTO-UX — verde de exigência × verde de confirmação', () {
    test('FOTO-UX-01 · opcional e sem foto → NEUTRO', () {
      expect(_bundle().photosStatus, SectionStatus.neutral);
    });

    test('FOTO-UX-02 · opcional com foto PERSISTIDA → REGISTRADO', () {
      // `evidences` é a lista do servidor. A foto ainda em upload vive em
      // `pendingPhotos`, que nem chega a este modelo.
      final bundle = _bundle(evidences: [_foto()]);
      expect(bundle.photosStatus, SectionStatus.recorded);
    });

    test('FOTO-UX-03 · exigido e insuficiente → PENDENTE, mesmo com foto', () {
      /*
        Aqui está o erro que este caso existe para impedir: uma foto gravada
        NÃO satisfaz um mínimo de três. Quem responde é a pendência do
        servidor; "tem foto" responde outra pergunta.
      */
      final bundle = _bundle(
        requirements: {'minEvidenceCount': 3},
        evidences: [_foto()],
        pendencies: [
          {'code': 'EVIDENCE_COUNT_BELOW_MINIMUM', 'message': 'Faltam fotos.'},
        ],
      );
      expect(bundle.photosStatus, SectionStatus.pending);
    });

    test('FOTO-UX-04 · exigido e satisfeito → CONCLUÍDO, não registrado', () {
      // Com exigência cumprida o selo afirma conclusão — e a seção volta a
      // contar no progresso.
      final bundle = _bundle(
        requirements: {'minEvidenceCount': 1},
        evidences: [_foto()],
      );
      expect(bundle.photosStatus, SectionStatus.done);
    });

    test('FOTO-UX-05 · categoria exigida e ausente → PENDENTE', () {
      final bundle = _bundle(
        requirements: {
          'requiredEvidenceCategories': ['OPTICAL_MEASUREMENT'],
        },
        evidences: [_foto()],
        pendencies: [
          {
            'code': 'EVIDENCE_CATEGORY_MISSING',
            'message': 'Falta a medição óptica.',
            'category': 'OPTICAL_MEASUREMENT',
          },
        ],
      );
      expect(bundle.photosStatus, SectionStatus.pending);
    });

    test('FOTO-UX-06 · foto opcional NÃO muda o denominador do progresso', () {
      /*
        A regressão que este caso trava: se `recorded` contasse como etapa, o
        técnico veria "1 de 1" virar "1 de 2" ao registrar uma foto que
        ninguém pediu — e o progresso andaria para trás por fazer trabalho a
        mais.
      */
      final antes = _bundle();
      final depois = _bundle(evidences: [_foto()]);

      expect(antes.progress.total, depois.progress.total);
      expect(antes.progress.done, depois.progress.done);
      // Controle positivo: só o relatório é exigido nos dois.
      expect(depois.progress.total, 1);
    });

    test('FOTO-UX-07 · material NÃO ganha verde por existir', () {
      // A confirmação positiva é da foto, por decisão do dono. Material
      // registrado numa OS que não o exige continua neutro — senão a tela
      // volta a marcar tudo e o selo perde o sentido.
      final bundle = _bundle(
        materials: [
          {
            'id': 'm-9',
            'description': 'Conector',
            'quantity': 2,
            'unit': 'un',
            'inventoryItemId': null,
          },
        ],
      );
      expect(bundle.materialsStatus, SectionStatus.neutral);
    });
  });

  group('SECSTATUS — a mesma autoridade alimenta barra e selos', () {
    test('SECSTATUS-01 · material segue a política, como o equipamento', () {
      expect(
        _bundle(requirements: {'requireMaterials': true}).materialsStatus,
        SectionStatus.pending,
      );
      expect(
        _bundle(
          requirements: {'requireMaterials': true},
          materials: [
            {
              'id': 'm-1',
              'description': 'Cabo',
              'quantity': 1,
              'unit': 'un',
              'inventoryItemId': null,
            },
          ],
        ).materialsStatus,
        SectionStatus.done,
      );
      expect(_bundle().materialsStatus, SectionStatus.neutral);
    });

    test(
      'SECSTATUS-02 · o progresso conta exatamente os selos não neutros',
      () {
        /*
        A barra e os selos leem a MESMA derivação. Sem isto, a tela poderia
        dizer "2 de 3" com quatro selos âmbar na frente — e as duas leituras
        discordando é pior que qualquer uma delas sozinha.
      */
        final bundle = _bundle(
          requirements: {'requireEquipment': true, 'requireSignature': true},
          equipments: [_equipamento()],
        );

        final status = [
          bundle.reportStatus,
          bundle.checkInStatus,
          bundle.checklistStatus,
          bundle.photosStatus,
          bundle.materialsStatus,
          bundle.equipmentStatus,
          bundle.signatureStatus,
        ];
        // Os dois estados que a política NÃO exige — e é por isso que
        // nenhum dos dois entra no denominador.
        final exigidos = status
            .where(
              (s) => s != SectionStatus.neutral && s != SectionStatus.recorded,
            )
            .toList(growable: false);
        final prontos = exigidos
            .where((s) => s == SectionStatus.done)
            .toList(growable: false);

        expect(bundle.progress.total, exigidos.length);
        expect(bundle.progress.done, prontos.length);
        // O caso montado: relatório (ok), equipamento (ok), assinatura (falta).
        expect(bundle.progress.total, 3);
        expect(bundle.progress.done, 2);
      },
    );

    test(
      'SECSTATUS-03 · pendência do servidor derruba o selo do relatório',
      () {
        final bundle = _bundle(
          pendencies: [
            {
              'code': 'EXECUTION_DIAGNOSIS_REQUIRED',
              'message': 'Preencha o diagnóstico.',
            },
          ],
        );
        expect(bundle.reportStatus, SectionStatus.pending);
      },
    );
  });

  /*
    A prova de TELA mora em `widget/execution_equipment_test.dart`, montando a
    `ExecutionScreen` de verdade.

    A primeira versão destes casos remontava o ícone aqui, a partir do mesmo
    getter — e teria passado com a tela não desenhando selo nenhum. Um teste
    que afirma a própria cópia da regra não prova a tela; prova a cópia.
  */
}
