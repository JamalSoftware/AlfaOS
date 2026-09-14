import 'package:alfaos_field/core/location/location_service.dart';
import 'package:alfaos_field/features/execution/domain/execution.dart';
import 'package:alfaos_field/features/execution/domain/location_confirm.dart';
import 'package:alfaos_field/features/execution/ui/location_confirm_dialog.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/harness.dart';

/// # O diálogo de confirmação em tela pequena (RC-1C)
///
/// O técnico lê isto de pé, com uma mão, e muitas vezes com a fonte do
/// aparelho aumentada. Os três desfechos — perto, longe e sem GPS — precisam
/// caber em 360 dp com texto a 130%, e as ações precisam dos 48 dp.
///
/// O diálogo é montado DENTRO do `MaterialApp` do harness, com a escala no
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

ConfirmLocationCheck _check(LocationReading reading) =>
    ConfirmLocationCheck.evaluate(location: _ponto, reading: reading);

Future<void> _montar(WidgetTester tester, ConfirmLocationCheck check) async {
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
        child: Scaffold(body: ConfirmLocationDialog(check: check)),
      ),
    ),
  );
  await tester.pumpAndSettle();
  // A escala chegou MESMO ao diálogo — sem isto o teste poderia passar em
  // texto de tamanho normal.
  final escala = MediaQuery.textScalerOf(
    tester.element(find.byType(ConfirmLocationDialog)),
  );
  expect(escala.scale(10), closeTo(13, 0.001));
}

void main() {
  testWidgets('perto: cabe em 360 dp a 130%, e Confirmar tem 48 dp', (
    tester,
  ) async {
    await _montar(
      tester,
      _check(
        const LocationReading.ok(
          DeviceLocation(
            latitude: -23.5505,
            longitude: -46.6333,
            accuracyMeters: 14,
          ),
        ),
      ),
    );
    expect(tester.takeException(), isNull);
    expect(find.text('Distância da sua posição: 15 m'), findsOneWidget);
    expect(
      tester.getSize(find.byKey(const Key('confirm-location-submit'))).height,
      greaterThanOrEqualTo(48),
    );
  });

  testWidgets('longe: cabe em 360 dp a 130%, e Corrigir tem 48 dp', (
    tester,
  ) async {
    await _montar(
      tester,
      _check(
        const LocationReading.ok(
          DeviceLocation(
            latitude: -23.529203,
            longitude: -46.6332,
            accuracyMeters: 14,
          ),
        ),
      ),
    );
    expect(tester.takeException(), isNull);
    expect(find.text('Distância da sua posição: 2,36 km'), findsOneWidget);
    expect(find.byKey(const Key('confirm-location-submit')), findsNothing);
    expect(
      tester
          .getSize(find.byKey(const Key('confirm-location-go-correct')))
          .height,
      greaterThanOrEqualTo(48),
    );
  });

  testWidgets('sem GPS: cabe em 360 dp a 130%, sem nenhuma ação de confirmar', (
    tester,
  ) async {
    await _montar(
      tester,
      _check(
        const LocationReading.failed(LocationOutcome.permissionDeniedForever),
      ),
    );
    expect(tester.takeException(), isNull);
    expect(find.textContaining('configurações do aparelho'), findsOneWidget);
    expect(find.byKey(const Key('confirm-location-submit')), findsNothing);
  });

  testWidgets('a coordenada do cliente não aparece em nenhum desfecho', (
    tester,
  ) async {
    await _montar(
      tester,
      _check(
        const LocationReading.ok(
          DeviceLocation(latitude: -23.529203, longitude: -46.6332),
        ),
      ),
    );
    expect(find.textContaining('-23.55'), findsNothing);
    expect(find.textContaining('-46.63'), findsNothing);
    expect(find.text('Precisão do GPS: não informada'), findsOneWidget);
  });
}
