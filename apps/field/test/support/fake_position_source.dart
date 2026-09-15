import 'dart:async';

import 'package:alfaos_field/core/location/operational_position.dart';

/// Uma leitura roteirizada: onde, com que precisão, quão velha, e quanto
/// depois da anterior ela chega.
class ScriptedReading {
  const ScriptedReading(
    this.latitude,
    this.longitude, {
    this.accuracy,
    this.age = Duration.zero,
    this.after = Duration.zero,
  });

  final double latitude;
  final double longitude;

  /// `null` = a plataforma não mediu a precisão.
  final double? accuracy;

  /// Quão velha a leitura já nasce — uma posição guardada tem idade.
  final Duration age;

  /// Quanto depois da leitura anterior (ou da abertura do fluxo) ela chega.
  final Duration after;
}

/// O GPS do aparelho, controlável — a fronteira `PositionSource`.
///
/// Cada `positions()` abre um fluxo NOVO que entrega [script] a partir do
/// momento em que alguém o escuta. O fluxo nunca fecha sozinho: um GPS de
/// verdade continua mandando até alguém cancelar, e é o cancelamento que um
/// teste precisa ver acontecer ([listening], [cancels]).
class FakePositionSource implements PositionSource {
  FakePositionSource({
    this.script = const [],
    this.serviceEnabled = true,
    this.permission = PositionPermission.granted,
    this.permissionAfterRequest = PositionPermission.granted,
    this.precise = true,
    this.preciseAfterRequest,
    DateTime Function()? clock,
  }) : _clock = clock ?? DateTime.now;

  List<ScriptedReading> script;
  bool serviceEnabled;
  PositionPermission permission;
  PositionPermission permissionAfterRequest;
  bool precise;

  /// A precisão depois do pedido — o diálogo de "localização precisa" do
  /// Android 12+. `null` = o pedido não muda nada.
  bool? preciseAfterRequest;

  /// Um erro do plugin, entregue no fluxo no lugar das leituras.
  Object? streamError;

  final DateTime Function() _clock;

  int requestCalls = 0;
  int watchCalls = 0;
  int cancels = 0;

  StreamController<RawPositionReading>? _atual;

  /// Há alguém medindo AGORA? Depois da captura, tem de ser `false`.
  bool get listening => _atual?.hasListener ?? false;

  /// Entrega uma leitura na hora, no fluxo aberto — para os testes que
  /// controlam a sequência à mão.
  void emit(ScriptedReading r) => _atual?.add(_bruta(r));

  RawPositionReading _bruta(ScriptedReading r) => RawPositionReading(
    latitude: r.latitude,
    longitude: r.longitude,
    accuracyMeters: r.accuracy,
    timestamp: _clock().subtract(r.age),
  );

  @override
  Future<bool> isServiceEnabled() async => serviceEnabled;

  @override
  Future<PositionPermission> checkPermission() async => permission;

  @override
  Future<PositionPermission> requestPermission() async {
    requestCalls += 1;
    permission = permissionAfterRequest;
    if (preciseAfterRequest != null) precise = preciseAfterRequest!;
    return permission;
  }

  @override
  Future<bool> isPrecise() async => precise;

  @override
  Stream<RawPositionReading> positions() {
    watchCalls += 1;
    final controller = StreamController<RawPositionReading>();
    _atual = controller;
    final agendadas = <Timer>[];
    controller.onListen = () {
      final erro = streamError;
      if (erro != null) {
        agendadas.add(Timer(Duration.zero, () => controller.addError(erro)));
        return;
      }
      var acumulado = Duration.zero;
      for (final r in script) {
        acumulado += r.after;
        agendadas.add(
          Timer(acumulado, () {
            if (!controller.isClosed) controller.add(_bruta(r));
          }),
        );
      }
    };
    controller.onCancel = () {
      cancels += 1;
      for (final t in agendadas) {
        t.cancel();
      }
    };
    return controller.stream;
  }
}
