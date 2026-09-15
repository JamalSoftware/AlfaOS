/// "Confirmar localização" — a medida que o técnico vê ANTES de confirmar.
///
/// ## Quem decide é o servidor (RC-1C)
///
/// O contrato aprovado pelo dono: confirmar exige a posição do aparelho, e só
/// vale a até `confirmMaxDistanceMeters` (100 m) do ponto cadastrado. O
/// servidor recalcula a distância e recusa acima do limite — sempre. O que
/// este arquivo faz é MOSTRAR a distância e desabilitar o botão antes de
/// enviar, com o número que o próprio servidor mandou no pacote. Se os dois
/// discordassem, a recusa do servidor apareceria como erro na tela; nunca uma
/// confirmação que ele não aceitaria.
///
/// ## A mesma conta do servidor
///
/// Haversine, mesmo raio (WGS-84 médio) e o mesmo arredondamento para metro
/// inteiro de `src/lib/geo.ts` — é o metro arredondado que decide o limite lá.
/// Os vetores de teste de `location_confirm_test.dart` são os mesmos de
/// `customer-location-confirm.test.ts`.
library;

import 'dart:math' as math;

import '../../../core/location/operational_position.dart';
import 'execution.dart';

/// Raio médio da Terra, em metros — o mesmo de `geo.ts`.
const double _earthRadiusMeters = 6371008.8;

/// Distância em metros inteiros entre dois pontos (haversine).
int distanceInMeters({
  required double fromLatitude,
  required double fromLongitude,
  required double toLatitude,
  required double toLongitude,
}) {
  double rad(double deg) => deg * math.pi / 180;
  final dLat = rad(toLatitude - fromLatitude);
  final dLng = rad(toLongitude - fromLongitude);
  final lat1 = rad(fromLatitude);
  final lat2 = rad(toLatitude);
  final h =
      math.pow(math.sin(dLat / 2), 2) +
      math.cos(lat1) * math.cos(lat2) * math.pow(math.sin(dLng / 2), 2);
  return (2 * _earthRadiusMeters * math.asin(math.min(1, math.sqrt(h))))
      .round();
}

/// "82 m" abaixo de 1 km; "2,36 km" a partir dele — igual ao servidor.
String formatDistanceMeters(int meters) {
  if (meters < 1000) return '$meters m';
  final km = (meters / 1000).toStringAsFixed(2).replaceAll('.', ',');
  return '$km km';
}

/// A medida para confirmar: onde o técnico está, a que distância do ponto, e
/// se isso permite confirmar.
///
/// Só existe a partir de uma posição CAPTURADA (RC-1C-HOTFIX): precisão até o
/// limite, leitura recente. Sem ela não há medida — a falha fica na captura,
/// que diz o motivo e deixa tentar de novo.
class ConfirmLocationCheck {
  const ConfirmLocationCheck({
    required this.fix,
    required this.distanceMeters,
    this.maxDistanceMeters,
    this.locationVersion,
  });

  /// Mede a posição capturada contra o ponto cadastrado.
  ///
  /// O ponto precisa existir — sem ele a saída é corrigir, e a tela nem
  /// oferece confirmar.
  factory ConfirmLocationCheck.evaluate({
    required ExecutionLocation location,
    required OperationalFix fix,
  }) {
    final lat = location.latitude;
    final lng = location.longitude;
    if (lat == null || lng == null) {
      throw ArgumentError('sem ponto cadastrado não há o que medir');
    }
    return ConfirmLocationCheck(
      fix: fix,
      distanceMeters: distanceInMeters(
        fromLatitude: fix.latitude,
        fromLongitude: fix.longitude,
        toLatitude: lat,
        toLongitude: lng,
      ),
      maxDistanceMeters: location.confirmMaxDistanceMeters,
      locationVersion: location.version,
    );
  }

  /// A posição medida — a MESMA que o diálogo mostra e que a confirmação
  /// envia.
  final OperationalFix fix;
  final int distanceMeters;

  /// A versão do ponto contra o qual a distância foi medida.
  ///
  /// É ela que a confirmação envia como `expectedVersion`: se o ponto mudou
  /// entre medir e confirmar, o servidor responde conflito — em vez de
  /// confirmar um ponto que o técnico não viu medido.
  final int? locationVersion;

  /// O limite que o SERVIDOR mandou. `null` num servidor anterior à RC-1C:
  /// aí o aplicativo não bloqueia sozinho, e a regra fica inteira do servidor.
  final int? maxDistanceMeters;

  /// Pode confirmar: dentro do limite de distância (inclusivo).
  bool get withinLimit =>
      maxDistanceMeters == null || distanceMeters <= maxDistanceMeters!;
}
