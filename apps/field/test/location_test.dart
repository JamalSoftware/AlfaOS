import 'package:alfaos_field/core/location/location_service.dart';
import 'package:flutter_test/flutter_test.dart';

/// Cada recusa de localização tem uma SAÍDA diferente, e por isso um texto
/// diferente.
///
/// Mandar o técnico às configurações do aparelho quando bastava tocar
/// "permitir" o faz desistir de uma ação de dois segundos; dizer "toque em
/// permitir" quando a permissão está bloqueada o deixa procurando um diálogo
/// que não vai mais aparecer.
void main() {
  test('sucesso não produz mensagem', () {
    const reading = LocationReading.ok(
      DeviceLocation(latitude: -23.5, longitude: -46.6),
    );
    expect(reading.message, isNull);
    expect(reading.hasPosition, isTrue);
  });

  test('negada agora convida a permitir', () {
    const reading = LocationReading.failed(LocationOutcome.permissionDenied);
    expect(reading.message, contains('Permissão de localização necessária'));
    expect(reading.hasPosition, isFalse);
  });

  test('negada permanentemente manda às configurações', () {
    const reading = LocationReading.failed(
      LocationOutcome.permissionDeniedForever,
    );
    // Repetir o pedido não adianta mais: só as configurações resolvem.
    expect(reading.message, contains('configurações'));
  });

  test('GPS desligado fala do GPS, não de permissão', () {
    const reading = LocationReading.failed(LocationOutcome.serviceDisabled);
    expect(reading.message, contains('GPS'));
    expect(reading.message, isNot(contains('Permissão')));
  });

  test('sem sinal diz que dá para continuar sem ela', () {
    const reading = LocationReading.failed(LocationOutcome.unavailable);
    // A ausência de coordenada é caminho normal — o atendimento segue.
    expect(reading.message, contains('continuar sem ela'));
  });
}
