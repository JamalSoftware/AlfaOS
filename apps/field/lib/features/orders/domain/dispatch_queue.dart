import 'service_order.dart';

/// # Fila operacional — o contrato que o despacho define (DQ-6)
///
/// `GET /api/field/v1/dispatch-queue` (`docs/FIELD-API.md`).
///
/// ## O aplicativo NÃO decide a ordem
///
/// `position` vem pronta do servidor, e `queued` chega ordenada. Nada aqui
/// ordena, e nada aqui deveria: o despachante moveu a OS Nº 7 para a 1ª e a
/// Nº 5 para a 2ª, e é isso que o técnico tem de ver — mesmo que a Nº 5 tenha
/// número menor, prioridade igual e horário mais cedo.
///
/// Foi exatamente esse o defeito que o piloto encontrou: a Web persistia a
/// ordem certa e o aplicativo continuava exibindo a sua.
class QueuedOrder {
  const QueuedOrder({required this.order, required this.position});

  final OrderSummary order;

  /// 1..N, contígua, **do servidor**. Nunca calculada aqui.
  final int position;

  /// `1ª`, `2ª`, `3ª` — a posição precisa ser lida sem contar linhas.
  String get ordinal => '$positionª';
}

/// A fila do técnico autenticado.
///
/// Não existe `technicianId` na requisição nem na resposta: o dono vem do
/// token. Um parâmetro com esse nome seria ignorado pelo servidor.
class DispatchQueue {
  const DispatchQueue({
    required this.queueVersion,
    required this.inProgress,
    required this.queued,
  });

  /// Token de leitura da fila. Serve para detectar mudança entre duas
  /// leituras; **não** é permissão de escrita — o Field é somente leitura
  /// nesta superfície, e não existe rota de reordenação para ele.
  final int queueVersion;

  /// COLEÇÃO. O AlfaOS permite mais de uma OS em atendimento por técnico, e
  /// esconder as demais apagaria trabalho que existe.
  final List<OrderSummary> inProgress;

  /// Já ordenada por `position`. **Não reordenar.**
  final List<QueuedOrder> queued;

  bool get isEmpty => inProgress.isEmpty && queued.isEmpty;

  /// A OS que o técnico deve atender a seguir — a `1ª` da fila.
  ///
  /// **"Próxima NA FILA" não é "próxima AGENDADA".** Esta é ordem operacional;
  /// `scheduledAt` é compromisso com o cliente, e uma OS pode ser a primeira
  /// sem ter horário nenhum (PRD §323).
  QueuedOrder? get nextInQueue => queued.isEmpty ? null : queued.first;

  /// Quantas OS abertas o técnico tem.
  ///
  /// Em atendimento **mais** enfileiradas. Concluída e cancelada não entram —
  /// nem chegam nesta resposta, que só traz `ASSIGNED` e `IN_PROGRESS`.
  int get openCount => inProgress.length + queued.length;

  int get urgentCount =>
      inProgress.where((o) => o.priority == OrderPriority.urgent).length +
      queued.where((q) => q.order.priority == OrderPriority.urgent).length;

  /// Lê a resposta do servidor.
  ///
  /// Devolve `null` quando o corpo **não** carrega `position` nos itens
  /// enfileirados — o caso de um APK novo contra um servidor anterior à DQ-5.
  /// Nulo aqui significa "esta superfície não está disponível", e quem decide
  /// o que fazer com isso é o controller: **presença de dado, não versão de
  /// APK** (`docs/DISPATCH-QUEUE.md` §12).
  static DispatchQueue? tryParse(Map<String, dynamic> json) {
    final rawQueued = json['queued'];
    final rawInProgress = json['inProgress'];
    if (rawQueued is! List || rawInProgress is! List) return null;

    final queued = <QueuedOrder>[];
    for (final item in rawQueued) {
      if (item is! Map) return null;
      final map = Map<String, dynamic>.from(item);
      final position = map['position'];
      // Sem posição não há fila autoritativa. Inventar um índice aqui seria
      // exatamente a segunda autoridade que esta fase existe para eliminar.
      if (position is! num) return null;
      queued.add(
        QueuedOrder(
          order: OrderSummary.fromJson(map),
          position: position.toInt(),
        ),
      );
    }

    return DispatchQueue(
      queueVersion: (json['queueVersion'] as num?)?.toInt() ?? 0,
      inProgress: rawInProgress
          .whereType<Map>()
          .map((m) => OrderSummary.fromJson(Map<String, dynamic>.from(m)))
          .toList(growable: false),
      queued: List.unmodifiable(queued),
    );
  }
}
