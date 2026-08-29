import '../../../core/api/field_api_client.dart';
import '../domain/workday.dart';

/// Acesso à jornada. Uma rota por operação, sem regra de negócio aqui.
///
/// O repositório **não calcula horas, não decide transição e não carimba
/// horário**. Os três são do servidor (PRD §227, §229, §230); reimplementá-los
/// aqui criaria uma segunda verdade que ninguém revisa.
class TimeClockRepository {
  TimeClockRepository({required FieldApiClient api}) : _api = api;

  final FieldApiClient _api;

  /// A jornada de hoje de quem está autenticado.
  Future<Workday> today() async {
    final data = await _api.get('/time-clock/today');
    final raw = data['workday'];
    if (raw is! Map) return Workday.empty;
    return Workday.fromJson(Map<String, dynamic>.from(raw));
  }

  /// Registra uma marcação.
  ///
  /// `idempotencyKey` é criada pelo chamador **no toque**, não aqui: é o que
  /// torna a retentativa segura e o que a fila offline vai precisar quando
  /// existir (PRD §232). Gerá-la no envio faria cada tentativa parecer um
  /// comando novo, e uma reconexão instável produziria três entradas.
  ///
  /// `deviceOccurredAt` viaja como METADATA. O horário oficial volta do
  /// servidor, e é ele que a tela mostra.
  Future<Workday> punch({
    required TimeEntryType type,
    required String idempotencyKey,
    required DateTime deviceOccurredAt,
    double? latitude,
    double? longitude,
    num? accuracyMeters,
  }) async {
    final data = await _api.post(
      '/time-clock/entries',
      idempotencyKey: idempotencyKey,
      body: {
        'type': timeEntryTypeWire(type),
        'deviceOccurredAt': deviceOccurredAt.toUtc().toIso8601String(),
        'latitude': ?latitude,
        'longitude': ?longitude,
        'accuracyMeters': ?accuracyMeters,
      },
    );

    // A resposta do comando traz o dia já atualizado, mas sem a lista de
    // marcações. Quem quiser a lista relê `today` — e é o que o controlador faz.
    final raw = data['workday'];
    if (raw is! Map) return Workday.empty;
    return Workday.fromJson(Map<String, dynamic>.from(raw));
  }

  Future<List<WorkdaySummary>> history({DateTime? from, DateTime? to}) async {
    String day(DateTime value) => value.toIso8601String().substring(0, 10);
    final data = await _api.get(
      '/time-clock/history',
      query: {
        if (from != null) 'from': day(from),
        if (to != null) 'to': day(to),
      },
    );
    final raw = data['workdays'];
    if (raw is! List) return const [];
    return raw
        .whereType<Map>()
        .map((e) => WorkdaySummary.fromJson(Map<String, dynamic>.from(e)))
        .toList(growable: false);
  }

  /// Abre um pedido de correção.
  ///
  /// O funcionário **não edita** a marcação (PRD §229). Ele descreve o que
  /// aconteceu; quem decide é alguém com autoridade.
  Future<void> requestAdjustment({
    required TimeEntryType requestedEntryType,
    required DateTime requestedOccurredAt,
    required String reason,
    required String idempotencyKey,
    String requestedType = 'MISSING_ENTRY',
    String? targetEntryId,
  }) async {
    await _api.post(
      '/time-clock/adjustments',
      idempotencyKey: idempotencyKey,
      body: {
        'requestedType': requestedType,
        'requestedEntryType': timeEntryTypeWire(requestedEntryType),
        'requestedOccurredAt': requestedOccurredAt.toUtc().toIso8601String(),
        'reason': reason,
        'targetEntryId': ?targetEntryId,
      },
    );
  }
}
