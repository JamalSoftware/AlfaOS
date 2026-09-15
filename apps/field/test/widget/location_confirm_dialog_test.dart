import 'dart:async';

import 'package:alfaos_field/core/location/operational_position.dart';
import 'package:alfaos_field/features/execution/domain/execution.dart';
import 'package:alfaos_field/features/execution/domain/location_confirm.dart';
import 'package:alfaos_field/features/execution/ui/location_confirm_dialog.dart';
import 'package:alfaos_field/features/execution/ui/location_fix_dialog.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/harness.dart';

/// # Os diálogos de localização em tela pequena (RC-1C + RC-1C-HOTFIX)
///
/// O técnico lê isto de pé, com uma mão, e muitas vezes com a fonte do
/// aparelho aumentada. Os desfechos — perto e longe na confirmação; buscando e
/// falhou na captura — precisam caber em 360 dp com texto a 130%, e as ações
/// precisam dos 48 dp.
///
/// Cada diálogo é montado DENTRO do `MaterialApp` do harness, com a escala no
/// meio: montado por `showDialog` ele iria para o `Overlay` da raiz e herdaria
/// o `MediaQuery` do aplicativo, e a escala seria descartada — o teste passaria
/// sem nunca ter lido texto grande (a lição de `network_section_test`).

const _ponto = ExecutionLocation(
  status: LocationStatus.unconfirmed,
  latitude: -23.5504,
  longitude: -46.6332,
  version: 0,
  confirmMaxDistanceMeters: 100,
);

ConfirmLocationCheck _check(double lat, double lng, {double precisao = 14}) =>
    ConfirmLocationCheck.evaluate(
      location: _ponto,
      fix: OperationalFix(
        latitude: lat,
        longitude: lng,
        accuracyMeters: precisao,
        capturedAt: DateTime.now(),
      ),
    );

Future<void> _montar(
  WidgetTester tester,
  Widget dialogo, {
  bool assentar = true,
}) async {
  final view =
      TestWidgetsFlutterBinding.instance.platformDispatcher.implicitView!;
  view.physicalSize = const Size(360, 640);
  view.devicePixelRatio = 1.0;
  addTearDown(view.reset);

  await Harness().pump(
    tester,
    Builder(
      builder: (context) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: const TextScaler.linear(1.3)),
        child: Scaffold(body: dialogo),
      ),
    ),
  );
  // A captura procurando tem uma barra animada: não assenta nunca.
  if (assentar) {
    await tester.pumpAndSettle();
  } else {
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(milliseconds: 50));
  }
  // A escala chegou MESMO ao diálogo — sem isto o teste poderia passar em
  // texto de tamanho normal.
  final escala = MediaQuery.textScalerOf(
    tester.element(find.byType(dialogo.runtimeType)),
  );
  expect(escala.scale(10), closeTo(13, 0.001));
}

double _altura(WidgetTester tester, String chave) =>
    tester.getSize(find.byKey(Key(chave))).height;

void main() {
  group('confirmação', () {
    testWidgets('perto: cabe em 360 dp a 130%, e Confirmar tem 48 dp', (
      tester,
    ) async {
      await _montar(
        tester,
        ConfirmLocationDialog(check: _check(-23.5505, -46.6333)),
      );
      expect(tester.takeException(), isNull);
      expect(find.text('Distância da sua posição: 15 m'), findsOneWidget);
      expect(
        _altura(tester, 'confirm-location-submit'),
        greaterThanOrEqualTo(48),
      );
    });

    testWidgets('longe: cabe em 360 dp a 130%, e Corrigir tem 48 dp', (
      tester,
    ) async {
      await _montar(
        tester,
        ConfirmLocationDialog(check: _check(-23.529203, -46.6332)),
      );
      expect(tester.takeException(), isNull);
      expect(find.text('Distância da sua posição: 2,36 km'), findsOneWidget);
      expect(find.byKey(const Key('confirm-location-submit')), findsNothing);
      expect(
        _altura(tester, 'confirm-location-go-correct'),
        greaterThanOrEqualTo(48),
      );
    });

    testWidgets(
      'a coordenada do cliente não aparece; a precisão sim, com o valor real',
      (tester) async {
        await _montar(
          tester,
          ConfirmLocationDialog(
            check: _check(-23.529203, -46.6332, precisao: 12.3),
          ),
        );
        expect(find.textContaining('-23.55'), findsNothing);
        expect(find.textContaining('-46.63'), findsNothing);
        expect(find.text('Precisão do GPS: 12,3 m'), findsOneWidget);
      },
    );
  });

  group('captura (RC-1C-HOTFIX)', () {
    testWidgets(
      'buscando: a precisão atual e a necessária cabem em 360 dp a 130%, e Cancelar tem 48 dp',
      (tester) async {
        final nunca = Completer<OperationalFixResult>();
        await _montar(
          tester,
          LocationFixDialog(
            maxAccuracyMeters: 50,
            acquire: ({onReading, cancel}) {
              onReading?.call(184.2);
              return nunca.future;
            },
          ),
          assentar: false,
        );
        expect(tester.takeException(), isNull);
        expect(find.text('Buscando uma localização precisa…'), findsOneWidget);
        expect(find.text('Precisão atual: 185 m'), findsOneWidget);
        expect(find.text('Precisão necessária: até 50 m.'), findsOneWidget);
        expect(_altura(tester, 'fix-cancel'), greaterThanOrEqualTo(48));
      },
    );

    testWidgets(
      'falhou (a frase mais longa, a da localização aproximada): cabe, e as duas ações têm 48 dp',
      (tester) async {
        await _montar(
          tester,
          LocationFixDialog(
            maxAccuracyMeters: 50,
            acquire: ({onReading, cancel}) async => const OperationalFixFailed(
              OperationalFixFailure.approximateOnly,
              maxAccuracyMeters: 50,
            ),
          ),
        );
        expect(tester.takeException(), isNull);
        expect(find.text('Localização precisa desativada'), findsOneWidget);
        expect(_altura(tester, 'fix-retry'), greaterThanOrEqualTo(48));
        expect(_altura(tester, 'fix-close'), greaterThanOrEqualTo(48));
      },
    );

    testWidgets('tempo esgotado com leitura ruim: a mensagem traz os metros', (
      tester,
    ) async {
      await _montar(
        tester,
        LocationFixDialog(
          maxAccuracyMeters: 50,
          acquire: ({onReading, cancel}) async => const OperationalFixFailed(
            OperationalFixFailure.timeout,
            maxAccuracyMeters: 50,
            bestAccuracyMeters: 74,
          ),
        ),
      );
      expect(tester.takeException(), isNull);
      expect(find.text('Precisão do GPS insuficiente'), findsOneWidget);
      expect(
        find.textContaining('Precisão do GPS insuficiente: 74 m.'),
        findsOneWidget,
      );
    });
  });
}
