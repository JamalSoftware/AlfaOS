import '../../../core/api/field_api_client.dart';
import '../../../core/errors/field_error.dart';
import '../domain/dispatch_queue.dart';
import '../domain/service_order.dart';

/// Resultado de um `start`, como a mutação o devolve.
///
/// O servidor responde com o estado que a PRÓPRIA operação produziu, e não com
/// uma releitura da OS — releitura filtra por posse, e uma reatribuição no
/// intervalo faria o app receber 404 para algo que aconteceu.
class StartOrderResult {
  const StartOrderResult({
    required this.status,
    required this.startedAt,
    required this.updatedAt,
    required this.version,
    required this.execution,
  });

  final OrderStatus status;
  final DateTime? startedAt;
  final DateTime updatedAt;
  final int version;
  final OrderExecution? execution;

  factory StartOrderResult.fromJson(Map<String, dynamic> json) {
    final order = Map<String, dynamic>.from(json['serviceOrder'] as Map);
    return StartOrderResult(
      status: OrderStatus.from(order['status'] as String?),
      startedAt: order['startedAt'] is String
          ? DateTime.tryParse(order['startedAt'] as String)?.toLocal()
          : null,
      updatedAt:
          (order['updatedAt'] is String
              ? DateTime.tryParse(order['updatedAt'] as String)?.toLocal()
              : null) ??
          DateTime.now(),
      version: (order['version'] as num?)?.toInt() ?? 0,
      execution: json['execution'] == null
          ? null
          : OrderExecution.fromJson(
              Map<String, dynamic>.from(json['execution'] as Map),
            ),
    );
  }
}

/// Resultado de uma releitura de diagnóstico.
///
/// `ok` e `diagnostic` são separados de propósito, e é o mesmo cuidado do
/// **erro ≠ OFFLINE**: quando a consulta falha, o último snapshot VÁLIDO
/// continua vindo, e `ok: false` diz que ele é velho. Assim a tela mostra "não
/// foi possível atualizar; última leitura: Online às 08:42" em vez de inventar
/// um estado — ou pior, exibir OFFLINE porque a integração caiu.
class DiagnosticRefresh {
  const DiagnosticRefresh({
    required this.ok,
    required this.diagnostic,
    required this.errorMessage,
  });

  final bool ok;
  final OrderDiagnostic? diagnostic;
  final String? errorMessage;

  factory DiagnosticRefresh.fromJson(Map<String, dynamic> json) {
    final error = json['error'];
    return DiagnosticRefresh(
      ok: json['ok'] as bool? ?? false,
      diagnostic: json['diagnostic'] == null
          ? null
          : OrderDiagnostic.fromJson(
              Map<String, dynamic>.from(json['diagnostic'] as Map),
            ),
      errorMessage: error is Map ? error['message'] as String? : null,
    );
  }
}

class OrdersRepository {
  OrdersRepository({required FieldApiClient api}) : _api = api;

  final FieldApiClient _api;

  /// A fila do técnico. **Só dele.**
  ///
  /// Não existe parâmetro de técnico: o dono é derivado do token no servidor.
  /// Mandar `technicianId` seria ignorado — e é bom que seja.
  Future<OrderPage> list({String? cursor, int limit = 25}) async {
    final data = await _api.get(
      '/service-orders',
      query: {'limit': limit, 'cursor': ?cursor},
    );
    return OrderPage.fromJson(data);
  }

  /// A fila operacional — a ordem que o DESPACHANTE definiu (DQ-5).
  ///
  /// Devolve `null` quando o servidor não oferece a superfície (rota ausente,
  /// 404) ou quando o corpo não traz `position`. Nulo é "indisponível", e não
  /// "vazia": o controller distingue os dois, porque uma fila legitimamente
  /// vazia NÃO deve cair no ranking local.
  Future<DispatchQueue?> dispatchQueue() async {
    try {
      final data = await _api.get('/dispatch-queue');
      return DispatchQueue.tryParse(data);
    } on FieldException catch (error) {
      // 404 é o servidor anterior à DQ-5: a rota não existe. Qualquer outro
      // erro sobe — falha de rede não pode virar "use o ranking local".
      if (error.status == 404) return null;
      rethrow;
    }
  }

  Future<OrderDetail> detail(String orderId) async {
    final data = await _api.get('/service-orders/$orderId');
    return OrderDetail.fromJson(
      Map<String, dynamic>.from(data['serviceOrder'] as Map),
    );
  }

  /// ASSIGNED → IN_PROGRESS.
  ///
  /// As duas proteções viajam juntas e respondem perguntas diferentes:
  ///
  /// - `idempotencyKey` cobre a REPETIÇÃO — a mesma intenção reenviada.
  /// - `expectedVersion` cobre a DIVERGÊNCIA — alguém mexeu na OS enquanto o
  ///   técnico estava sem rede.
  ///
  /// Uma não substitui a outra, e nenhuma das duas é decidida aqui: a
  /// transição, o compare-and-set e a timeline são do domínio do AlfaOS.
  Future<StartOrderResult> start({
    required String orderId,
    required int expectedVersion,
    required String idempotencyKey,
  }) async {
    final data = await _api.post(
      '/service-orders/$orderId/start',
      idempotencyKey: idempotencyKey,
      body: {'expectedVersion': expectedVersion},
    );
    return StartOrderResult.fromJson(data);
  }

  /// Revela a senha da conexão do cliente.
  ///
  /// O valor devolvido é para **mostrar e esquecer**. Ele não é gravado em
  /// lugar nenhum: cache offline é armazenamento durável num aparelho que anda
  /// pela rua e é roubado (`docs/SECURITY.md` §8.9).
  Future<String> revealConnectionPassword({
    required String orderId,
    required String connectionId,
  }) async {
    final data = await _api.post(
      '/service-orders/$orderId/pppoe/reveal',
      body: {'connectionId': connectionId},
    );
    return data['password'] as String? ?? '';
  }

  Future<DiagnosticRefresh> refreshDiagnostic(String orderId) async {
    final data = await _api.post('/service-orders/$orderId/diagnostic');
    return DiagnosticRefresh.fromJson(data);
  }
}
