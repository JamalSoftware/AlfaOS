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
