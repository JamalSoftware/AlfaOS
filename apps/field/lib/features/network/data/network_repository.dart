import '../../../core/api/field_api_client.dart';
import '../domain/network.dart';

/// Acesso à rede de distribuição **pela ordem de serviço**.
///
/// ## A fronteira, e por que ela é estrutural
///
/// Todo caminho daqui começa em `/service-orders/:id/network`. A OS é a
/// autorização, e ela é o **caminho** — não um campo do corpo que o servidor
/// depois resolve confiar. Não existe método que fale com `/api/cto-connections`:
/// aquela é a superfície administrativa, e um `TECHNICIAN` recebe `403` nela.
///
/// ## O que NUNCA vai no corpo
///
/// `customerId`, `companyId`, `technicianId`, `serviceOrderId`, `source` e
/// carimbo de tempo nenhum. Os schemas do servidor são `.strict()` e recusam
/// qualquer um deles — mas a razão de não estarem aqui não é o servidor
/// recusar: é que **o cliente vem da OS**, e mandar um seria afirmar que o
/// aparelho decide de quem é o vínculo.
class NetworkRepository {
  NetworkRepository({required FieldApiClient api}) : _api = api;

  final FieldApiClient _api;

  String _base(String orderId) => '/service-orders/$orderId/network';

  /// O vínculo do cliente da OS, ou `null` quando não há.
  Future<NetworkPlacement?> current(String orderId) async {
    final data = await _api.get(_base(orderId));
    final raw = data['connection'];
    if (raw is! Map) return null;
    return NetworkPlacement.fromJson(Map<String, dynamic>.from(raw));
  }

  /// As caixas candidatas do tenant da OS.
  ///
  /// `search` e `limit` existem porque a resposta é paginada no servidor —
  /// carregar a rede inteira para uma tela que precisa de uma caixa seria
  /// gastar a pior rede do sistema com dado que ninguém lê.
  Future<List<CandidateCto>> candidates(
    String orderId, {
    String? search,
    int? limit,
  }) async {
    final data = await _api.get(
      '${_base(orderId)}/ctos',
      query: {
        if (search != null && search.isNotEmpty) 'search': search,
        'limit': ?limit,
      },
    );
    return (data['ctos'] as List? ?? const [])
        .whereType<Map>()
        .map((e) => CandidateCto.fromJson(Map<String, dynamic>.from(e)))
        .toList(growable: false);
  }

  /// Uma caixa com as posições dela.
  Future<CandidateCtoDetail> cto(String orderId, String ctoId) async {
    final data = await _api.get('${_base(orderId)}/ctos/$ctoId');
    return CandidateCtoDetail.fromJson(
      Map<String, dynamic>.from(data['cto'] as Map),
    );
  }

  /// Liga o cliente **da OS** a uma porta.
  ///
  /// As duas proteções viajam juntas e respondem perguntas diferentes:
  /// `idempotencyKey` cobre a REPETIÇÃO da mesma intenção; `expectedVersion`
  /// cobre a DIVERGÊNCIA — alguém mexeu na OS enquanto o técnico decidia.
  Future<NetworkMutationResult> connect(
    String orderId, {
    required int expectedVersion,
    required String ctoPortId,
    required String idempotencyKey,
  }) async {
    final data = await _api.post(
      '${_base(orderId)}/connect',
      idempotencyKey: idempotencyKey,
      body: {'expectedVersion': expectedVersion, 'ctoPortId': ctoPortId},
    );
    return NetworkMutationResult.fromJson(data);
  }

  /// Encerra o vínculo que a TELA está mostrando.
  ///
  /// `expectedConnectionId` é obrigatório e não tem valor padrão: sem ele a
  /// operação seria *encerre o que este cliente tiver agora*, e uma tela
  /// desatualizada bastaria para fechar um vínculo que o técnico nunca viu.
  Future<NetworkMutationResult> disconnect(
    String orderId, {
    required int expectedVersion,
    required String expectedConnectionId,
    required String idempotencyKey,
    String? reason,
  }) async {
    final data = await _api.post(
      '${_base(orderId)}/disconnect',
      idempotencyKey: idempotencyKey,
      body: {
        'expectedVersion': expectedVersion,
        'expectedConnectionId': expectedConnectionId,
        if (reason != null && reason.isNotEmpty) 'reason': reason,
      },
    );
    return NetworkMutationResult.fromJson(data);
  }

  /// Move o cliente de porta — **uma requisição, não duas**.
  ///
  /// Desconectar e conectar em seguida abriria uma janela em que o cliente não
  /// está em porta nenhuma, e nenhum dos dois lados poderia desfazer o outro se
  /// a rede caísse no meio. O servidor fecha e abre na mesma transação, e é
  /// isso que a auditoria registra como `MOVED`.
  Future<NetworkMutationResult> move(
    String orderId, {
    required int expectedVersion,
    required String expectedConnectionId,
    required String targetCtoPortId,
    required String idempotencyKey,
    String? reason,
  }) async {
    final data = await _api.post(
      '${_base(orderId)}/move',
      idempotencyKey: idempotencyKey,
      body: {
        'expectedVersion': expectedVersion,
        'expectedConnectionId': expectedConnectionId,
        'targetCtoPortId': targetCtoPortId,
        if (reason != null && reason.isNotEmpty) 'reason': reason,
      },
    );
    return NetworkMutationResult.fromJson(data);
  }
}
