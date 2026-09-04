import 'package:flutter/foundation.dart';

/// # Para onde uma notificação leva (`NF-4`)
///
/// O ÚNICO lugar que interpreta o payload de push. Nenhum listener consulta
/// `data['type']` por conta própria: três listeners com três interpretações
/// divergem no dia em que um evento novo aparecer, e o que divergiria em
/// silêncio é justamente para onde o técnico é levado.
///
/// ## Push é indicação de destino, NUNCA autorização
///
/// O payload chega pela rede, e um aparelho comprometido pode forjá-lo. Nada
/// aqui concede acesso: o destino é uma ROTA, e a rota abre a tela de detalhe,
/// que consulta o servidor pelo fluxo autenticado de sempre. Quem decide se
/// aquela OS ainda é daquele técnico é o backend — e continua decidindo do
/// mesmo jeito, sem saber que veio de um push.
///
/// ## Allowlist, não roteador genérico
///
/// Só o que existe de verdade é aceito. Um `resourceType` novo não vira rota
/// sozinho: ele é ignorado até alguém decidir, no código, o que ele significa.
/// Um roteador genérico transformaria o payload num seletor de tela — e um
/// payload forjado escolheria qualquer tela do aplicativo.
@immutable
class PushDestination {
  const PushDestination._({
    required this.eventType,
    required this.resourceId,
    required this.route,
  });

  /// O evento que originou o aviso. Hoje, só `SERVICE_ORDER_ASSIGNED`.
  final String eventType;

  /// O identificador do recurso, já validado.
  final String resourceId;

  /// A rota do GoRouter. Montada aqui, nunca no listener.
  final String route;

  /// O único evento com destino nesta fase.
  static const serviceOrderAssigned = 'SERVICE_ORDER_ASSIGNED';

  /// O único `resourceType` com destino nesta fase.
  static const serviceOrderResource = 'ServiceOrder';

  /*
    O formato do identificador é validado, e isso é segurança, não capricho.

    Os ids do projeto são `cuid()`: letras minúsculas e dígitos, cerca de 25
    caracteres. A validação aceita um pouco mais que isso de propósito — o
    objetivo não é adivinhar o gerador, é fechar o que faria a rota escapar.

    Sem ela, `resourceId = "abc/execucao"` viraria `/orders/abc/execucao` e o
    payload passaria a ESCOLHER a tela: um push forjado abriria a execução de
    uma OS, ou qualquer rota que um caminho relativo alcance. O identificador
    preenche UM segmento de caminho, então barra, ponto e espaço não têm o que
    fazer nele.
  */
  static final _idValido = RegExp(r'^[A-Za-z0-9_-]{1,64}$');

  /// Interpreta o payload. Devolve `null` quando não há destino.
  ///
  /// **Nunca lança.** O payload vem da rede e de uma camada nativa: campo
  /// ausente, tipo errado, mapa nulo e valor inesperado são entrada normal,
  /// não exceção. Um parser que estoura derruba o aplicativo na abertura,
  /// que é exatamente quando o `getInitialMessage` é consultado.
  static PushDestination? fromData(Map<String, dynamic>? data) {
    if (data == null) return null;

    final tipo = _texto(data['type']);
    final recurso = _texto(data['resourceType']);
    final id = _texto(data['resourceId']);

    if (tipo == null || tipo != serviceOrderAssigned) return null;
    if (recurso == null || recurso != serviceOrderResource) return null;
    if (id == null || !_idValido.hasMatch(id)) return null;

    return PushDestination._(
      eventType: tipo,
      resourceId: id,
      route: '/orders/$id',
    );
  }

  /// Lê um campo como texto, seja qual for o que veio.
  ///
  /// A camada nativa entrega `Map<String, dynamic>`, e um payload malformado
  /// pode trazer número, lista ou mapa onde deveria haver texto. `as String`
  /// lançaria; isto simplesmente não reconhece o destino.
  static String? _texto(Object? valor) {
    if (valor is String) {
      final limpo = valor.trim();
      return limpo.isEmpty ? null : limpo;
    }
    return null;
  }

  /// O destino que uma notificação da central representa, se houver.
  ///
  /// A tela de notificações e o push respondem à MESMA pergunta — "para onde
  /// este aviso leva?" — e por isso passam pelo mesmo lugar. Dois caminhos de
  /// navegação divergiriam, e o que ficasse para trás seria o menos usado.
  static PushDestination? forNotification({
    required String type,
    required String? resourceType,
    required String? resourceId,
  }) {
    return fromData({
      'type': type,
      'resourceType': resourceType,
      'resourceId': resourceId,
    });
  }

  @override
  bool operator ==(Object other) =>
      other is PushDestination && other.route == route;

  @override
  int get hashCode => route.hashCode;

  /// Sem `resourceId` em texto livre: o destino aparece em log, e um
  /// identificador de OS é dado operacional de uma empresa.
  @override
  String toString() => 'PushDestination($eventType)';
}
