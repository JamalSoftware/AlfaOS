/// Acesso ao GPS do aparelho — **só enquanto o app está em uso**.
///
/// ## Por que existe uma abstração
///
/// Duas razões, e nenhuma é purismo. A primeira é teste: um widget test não tem
/// GPS, e sem esta fronteira toda tela que lê localização viraria intestável. A
/// segunda é que o Field precisa tratar a AUSÊNCIA de coordenada como caminho
/// normal — permissão negada, prédio sem sinal, aparelho sem fix — e um serviço
/// que só sabe lançar exceção empurra essa decisão para cada chamador.
///
/// ## O que este serviço NÃO faz
///
/// Não pede localização em segundo plano, não observa posição continuamente e
/// não guarda histórico. O AlfaOS não rastreia técnico fora do atendimento
/// (PRD §138): rastreamento é outra capability, com outro consentimento — não
/// um efeito colateral desta.
///
/// ## O aparelho coleta; o Core decide
///
/// A coordenada devolvida aqui é DADO DE ENTRADA, nunca prova de autorização
/// nem confirmação de nada. Quem decide se ela vira `verified` é o servidor,
/// depois de uma ação humana explícita (PRD §130, §172).
library;

import 'package:geolocator/geolocator.dart';

import '../logging/log.dart';

/// Desfecho de uma leitura. Todos são caminhos normais, inclusive as recusas.
enum LocationOutcome {
  ok,

  /// O técnico negou agora. Pode ser pedido de novo depois.
  permissionDenied,

  /// Negado permanentemente: só as configurações do sistema resolvem, e o app
  /// precisa dizer isso em vez de repetir um diálogo que não vai mais aparecer.
  permissionDeniedForever,

  /// O GPS do aparelho está desligado.
  serviceDisabled,

  /// Tinha permissão e mesmo assim não veio posição — sem sinal, dentro de
  /// prédio, tempo esgotado.
  unavailable,
}

class DeviceLocation {
  const DeviceLocation({
    required this.latitude,
    required this.longitude,
    this.accuracyMeters,
  });

  final double latitude;
  final double longitude;
  final int? accuracyMeters;
}

class LocationReading {
  const LocationReading({required this.outcome, this.position});

  const LocationReading.ok(DeviceLocation position)
    : this(outcome: LocationOutcome.ok, position: position);

  const LocationReading.failed(LocationOutcome outcome)
    : this(outcome: outcome);

  final LocationOutcome outcome;
  final DeviceLocation? position;

  bool get hasPosition => position != null;

  /// Frase para a tela quando não veio posição.
  ///
  /// Cada recusa tem uma SAÍDA diferente, e por isso cada uma tem seu texto:
  /// mandar o técnico às configurações quando bastava tocar "permitir" o faria
  /// desistir de uma ação de dois segundos.
  String? get message => switch (outcome) {
    LocationOutcome.ok => null,
    LocationOutcome.permissionDenied =>
      'Permissão de localização necessária para confirmar este endereço.',
    LocationOutcome.permissionDeniedForever =>
      'A permissão de localização está bloqueada. Libere nas configurações do '
          'aparelho para confirmar endereços.',
    LocationOutcome.serviceDisabled =>
      'O GPS do aparelho está desligado. Ligue-o para registrar a localização.',
    LocationOutcome.unavailable => 'Não foi possível obter a localização agora. Você pode continuar sem ela.',
  };
}

abstract class LocationService {
  /// Posição atual, pedindo permissão se ainda não houver.
  Future<LocationReading> current();
}

class GeolocatorLocationService implements LocationService {
  const GeolocatorLocationService();

  /// Teto da espera por um fix.
  ///
  /// Quinze segundos. Sem limite, o técnico fica olhando um spinner dentro de
  /// um prédio onde o fix nunca vai chegar; com um limite curto demais, uma
  /// leitura legítima em céu aberto falharia.
  static const _timeout = Duration(seconds: 15);

  @override
  Future<LocationReading> current() async {
    try {
      if (!await Geolocator.isLocationServiceEnabled()) {
        return const LocationReading.failed(LocationOutcome.serviceDisabled);
      }

      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.deniedForever) {
        return const LocationReading.failed(
          LocationOutcome.permissionDeniedForever,
        );
      }
      if (permission == LocationPermission.denied) {
        return const LocationReading.failed(LocationOutcome.permissionDenied);
      }

      final position = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: _timeout,
        ),
      );

      return LocationReading.ok(
        DeviceLocation(
          latitude: position.latitude,
          longitude: position.longitude,
          // `accuracy` vem em metros e pode ser 0 quando o aparelho não estima.
          accuracyMeters: position.accuracy > 0
              ? position.accuracy.round()
              : null,
        ),
      );
    } catch (error) {
      // Nunca derruba a tela: sem coordenada é caminho normal, e o atendimento
      // continua. O erro fica no log, não no rosto do técnico.
      Log.error('falha ao ler a localização', error: error);
      return const LocationReading.failed(LocationOutcome.unavailable);
    }
  }
}
