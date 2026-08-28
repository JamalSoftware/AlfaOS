import 'package:uuid/uuid.dart';

/// Chave de idempotência dos comandos do Field.
///
/// ## A regra que faz ela funcionar
///
/// A chave é gerada **no momento da INTENÇÃO do usuário** — quando o técnico
/// toca o botão — e não no momento do envio. Gerada no envio, cada retentativa
/// produziria uma chave nova e a proteção simplesmente não existiria: o
/// servidor veria três comandos distintos e executaria os três.
///
/// É por isso que quem chama guarda a chave e a reapresenta, em vez de pedir
/// uma nova a cada tentativa.
///
/// O formato respeita o que o backend valida: 8–200 caracteres em
/// `[A-Za-z0-9._:-]`.
class IdempotencyKey {
  const IdempotencyKey._();

  static const _uuid = Uuid();

  /// Nova chave para uma intenção. O prefixo da operação não é exigido pelo
  /// contrato — ele existe para que um log de servidor diga qual comando
  /// aquela chave representava.
  static String forOperation(String operation) {
    final slug = operation.replaceAll(RegExp(r'[^A-Za-z0-9]'), '-');
    return '$slug-${_uuid.v4()}';
  }
}
