import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';

/// O mapa que o `LocationMapper.toHashMap` nativo do `geolocator_android`
/// 4.6.2 entrega pelo canal.
///
/// `accuracy` só existe quando o Android mediu — no nativo,
/// `if (location.hasAccuracy()) position.put("accuracy", …)`. [accuracy]
/// `null` reproduz a leitura sem medida: a chave some do mapa.
Map<String, dynamic> nativeAndroidLocation({
  required double latitude,
  required double longitude,
  required DateTime timestamp,
  double? accuracy,
}) => {
  'latitude': latitude,
  'longitude': longitude,
  'timestamp': timestamp.millisecondsSinceEpoch,
  'is_mocked': false,
  'accuracy': ?accuracy,
};

/// O plugin do Android até a borda do canal nativo — RC-1C-HOTFIX-3.
///
/// Cada mensagem vira `Position` por `AndroidPosition.fromMap`, a MESMA
/// conversão de `GeolocatorAndroid.getPositionStream` (`geolocator_android`
/// 4.6.2, `lib/src/geolocator_android.dart`). É nela que `hasAccuracy` se
/// perde, e é por ela que a captura precisa passar num teste: o dublê abaixo
/// de `PositionSource` (`FakePositionSource`) pula justamente a conversão onde
/// o defeito morava.
class FakeAndroidGeolocatorPlatform extends GeolocatorPlatform {
  bool serviceEnabled = true;
  LocationPermission permission = LocationPermission.whileInUse;
  LocationAccuracyStatus accuracyStatus = LocationAccuracyStatus.precise;

  /// Mensagens entregues assim que alguém escuta o fluxo.
  List<Map<String, dynamic>> script = const [];

  /// O que a captura pediu ao plugin na última abertura do fluxo.
  LocationSettings? lastSettings;
  int streamOpens = 0;
  int lastKnownCalls = 0;
  int currentPositionCalls = 0;

  StreamController<Map<String, dynamic>>? _canal;

  /// Há alguém medindo AGORA?
  bool get listening => _canal?.hasListener ?? false;

  /// Entrega uma mensagem do canal nativo no fluxo aberto.
  void emit(Map<String, dynamic> nativa) => _canal?.add(nativa);

  /// Uma falha do plugin no fluxo aberto — como o `handleError` do
  /// `GeolocatorAndroid` a entregaria, já traduzida da `PlatformException`.
  void emitError(Object erro) => _canal?.addError(erro);

  @override
  Future<bool> isLocationServiceEnabled() async => serviceEnabled;

  @override
  Future<LocationPermission> checkPermission() async => permission;

  @override
  Future<LocationPermission> requestPermission() async => permission;

  @override
  Future<LocationAccuracyStatus> getLocationAccuracy() async => accuracyStatus;

  @override
  Future<Position?> getLastKnownPosition({
    bool forceLocationManager = false,
  }) async {
    lastKnownCalls += 1;
    return null;
  }

  @override
  Future<Position> getCurrentPosition({LocationSettings? locationSettings}) {
    currentPositionCalls += 1;
    throw UnimplementedError('a captura não usa getCurrentPosition');
  }

  @override
  Stream<Position> getPositionStream({LocationSettings? locationSettings}) {
    streamOpens += 1;
    lastSettings = locationSettings;
    final canal = StreamController<Map<String, dynamic>>();
    _canal = canal;
    final roteiro = List.of(script);
    canal.onListen = () {
      for (final nativa in roteiro) {
        scheduleMicrotask(() {
          if (!canal.isClosed && canal.hasListener) canal.add(nativa);
        });
      }
    };
    return canal.stream.map(
      (nativa) => AndroidPosition.fromMap(nativa.cast<String, dynamic>()),
    );
  }
}

/// Põe o plugin do Android no lugar do plugin real, e o devolve ao final do
/// teste — com a plataforma-alvo Android, para a captura montar as
/// `AndroidSettings` como no aparelho.
FakeAndroidGeolocatorPlatform installFakeAndroidGeolocator() {
  final anterior = GeolocatorPlatform.instance;
  final plataforma = FakeAndroidGeolocatorPlatform();
  GeolocatorPlatform.instance = plataforma;
  debugDefaultTargetPlatformOverride = TargetPlatform.android;
  addTearDown(() {
    GeolocatorPlatform.instance = anterior;
    debugDefaultTargetPlatformOverride = null;
  });
  return plataforma;
}
