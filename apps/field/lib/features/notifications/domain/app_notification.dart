import '../../../core/push/push_destination.dart';

/// Aviso interno do técnico.
///
/// **A central é o registro; o push é apenas o aviso** (PRD §154). Como o FCM
/// ainda não existe, esta lista é o ÚNICO caminho pelo qual uma atribuição
/// chega ao técnico — não é uma aba decorativa.
class AppNotification {
  const AppNotification({
    required this.id,
    required this.type,
    required this.title,
    required this.body,
    required this.resourceType,
    required this.resourceId,
    required this.readAt,
    required this.createdAt,
  });

  final String id;
  final String type;
  final String title;
  final String body;

  /// Ponteiro para a tela, **não permissão**. Abrir a OS reconfere a
  /// autorização na API: uma OS reatribuída responde 404, e é assim que tem de
  /// ser — deep link não é prova de acesso.
  final String? resourceType;
  final String? resourceId;

  final DateTime? readAt;
  final DateTime createdAt;

  bool get isUnread => readAt == null;

  /// Para onde este aviso leva, se levar a algum lugar.
  ///
  /// Passa pelo MESMO parser do push (`NF-4`). A pergunta é idêntica — "para
  /// onde este aviso leva?" — e duas respostas para ela divergiriam: a desta
  /// tela exigia apenas `resourceId` não vazio, enquanto a do push valida o
  /// formato do identificador.
  ///
  /// A validação é **defesa em profundidade**, não fechamento de vetor: hoje
  /// existe uma única escrita de `Notification.resourceId` em produção, e ela
  /// grava o `id` da OS. O valor está em não depender disso continuar
  /// verdadeiro — um `resourceId` com barra montaria `/orders/abc/execucao`, e
  /// o registro passaria a ESCOLHER a tela.
  PushDestination? get destination => PushDestination.forNotification(
    type: type,
    resourceType: resourceType,
    resourceId: resourceId,
  );

  bool get pointsToServiceOrder => destination != null;

  factory AppNotification.fromJson(Map<String, dynamic> json) =>
      AppNotification(
        id: json['id'] as String,
        type: json['type'] as String? ?? '',
        title: json['title'] as String? ?? '',
        body: json['body'] as String? ?? '',
        resourceType: json['resourceType'] as String?,
        resourceId: json['resourceId'] as String?,
        readAt: json['readAt'] is String
            ? DateTime.tryParse(json['readAt'] as String)?.toLocal()
            : null,
        createdAt:
            (json['createdAt'] is String
                ? DateTime.tryParse(json['createdAt'] as String)?.toLocal()
                : null) ??
            DateTime.now(),
      );

  AppNotification markedRead(DateTime at) => AppNotification(
    id: id,
    type: type,
    title: title,
    body: body,
    resourceType: resourceType,
    resourceId: resourceId,
    readAt: at,
    createdAt: createdAt,
  );
}

class NotificationPage {
  const NotificationPage({
    required this.items,
    required this.nextCursor,
    required this.unreadCount,
  });

  final List<AppNotification> items;
  final String? nextCursor;
  final int unreadCount;

  factory NotificationPage.fromJson(Map<String, dynamic> json) =>
      NotificationPage(
        items: (json['items'] as List<dynamic>? ?? [])
            .map(
              (e) =>
                  AppNotification.fromJson(Map<String, dynamic>.from(e as Map)),
            )
            .toList(),
        nextCursor: json['nextCursor'] as String?,
        unreadCount: (json['unreadCount'] as num?)?.toInt() ?? 0,
      );
}
