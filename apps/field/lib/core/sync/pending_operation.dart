/// Contrato da fila local de operações — **preparado, não construído**.
///
/// O PRD (§158–§161) classifica offline como P0 da trilha Field, e o backend
/// já entrega o que ele precisa: idempotência escopada, `version`/CAS,
/// timestamps e semântica determinística de conflito.
///
/// O que **não** existe nesta Alpha é o motor no cliente: persistência da fila,
/// reenvio em background e a tela de status por item. Construí-lo agora, com
/// uma única mutação implementada (`start`), produziria um mecanismo sem
/// consumidor — e um motor de sincronização que ninguém exercita é onde os bugs
/// se escondem até o dia em que ele importa.
///
/// Estes tipos existem porque a decisão de nomes e estados é barata agora e
/// cara depois: as telas e os repositórios já podem falar deles.
library;

/// Estado de uma operação na fila local (PRD §159).
enum SyncStatus {
  /// Registrada no aparelho, ainda não enviada.
  pending,

  /// Enviando agora.
  syncing,

  /// O servidor confirmou.
  synced,

  /// O servidor recusou por divergência de estado — versão velha, OS
  /// reatribuída, OS cancelada. **Precisa de gente**: nunca "último que
  /// sincroniza vence" para decisão operacional.
  conflict,

  /// Falhou por motivo não recuperável sozinho.
  failed,
}

/// Tipos de operação que a fila vai carregar.
///
/// Só `startOrder` é executável hoje. Os demais estão nomeados porque a
/// listagem é a especificação — não porque exista código atrás deles.
enum PendingOperationType {
  startOrder,

  // Fases seguintes. Nenhum destes tem implementação nesta Alpha.
  addPhoto,
  useMaterial,
  checklistItem,
  addNote,
  signature,
  completeOrder,
}

/// Uma operação registrada localmente.
///
/// `localOperationId` é gerado **no momento da ação do técnico**, não no envio
/// — é a mesma regra da chave de idempotência, e pelo mesmo motivo: gerado no
/// envio, cada retentativa criaria uma identidade nova e a desduplicação
/// deixaria de existir.
///
/// `payload` guarda o que o técnico registrou. **Nunca credencial nem token**:
/// a fila é armazenamento durável num aparelho que anda pela rua.
class PendingOperation {
  const PendingOperation({
    required this.localOperationId,
    required this.type,
    required this.serviceOrderId,
    required this.createdAt,
    required this.status,
    this.payload = const {},
    this.retryCount = 0,
  });

  final String localOperationId;
  final PendingOperationType type;
  final String serviceOrderId;
  final DateTime createdAt;
  final SyncStatus status;
  final Map<String, Object?> payload;
  final int retryCount;
}
