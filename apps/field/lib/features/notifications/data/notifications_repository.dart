import '../../../core/api/field_api_client.dart';
import '../domain/app_notification.dart';

class NotificationsRepository {
  NotificationsRepository({required FieldApiClient api}) : _api = api;

  final FieldApiClient _api;

  Future<NotificationPage> list({String? cursor, int limit = 30}) async {
    final data = await _api.get(
      '/notifications',
      query: {'limit': limit, 'cursor': ?cursor},
    );
    return NotificationPage.fromJson(data);
  }

  /// Marca como lidas. Sem `ids`, marca todas as não lidas.
  ///
  /// **Não exige chave de idempotência**, e isso é do contrato, não descuido: o
  /// servidor filtra por `readAt: null`, então repetir não mexe no carimbo
  /// original nem produz efeito segundo. Exigir a chave seria burocracia sem
  /// proteção.
  Future<int> markRead({List<String>? ids}) async {
    final data = await _api.post(
      '/notifications',
      body: {if (ids != null && ids.isNotEmpty) 'ids': ids},
    );
    return (data['updated'] as num?)?.toInt() ?? 0;
  }
}

/// Ponto de extensão para o push real.
///
/// O FCM **não** está integrado: exigiria projeto no Google, credencial de
/// serviço e uma decisão de infraestrutura fora do escopo da Alpha. O backend
/// já tem o outbox e o `pushToken` opcional em `MobileDevice`; falta só o
/// provider real dos dois lados.
///
/// Esta interface existe para que o dia da integração seja uma implementação
/// nova, e não uma cirurgia. Ela **não finge entrega**: `register` devolve
/// null, e nada no aplicativo afirma que push está funcionando.
abstract class PushRegistrationService {
  /// Token do provider de push, ou null quando não há provider.
  Future<String?> register();
}

class NoopPushRegistrationService implements PushRegistrationService {
  const NoopPushRegistrationService();

  @override
  Future<String?> register() async => null;
}
