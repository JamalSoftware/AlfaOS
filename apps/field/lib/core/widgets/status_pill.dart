import 'package:flutter/material.dart';

import '../../app/theme/tokens.dart';
import '../../features/orders/domain/service_order.dart';

/// Chip de estado operacional.
///
/// **Traduz, não decide.** A máquina de estados vive no domínio do AlfaOS; aqui
/// só se escolhe a cor de um rótulo que veio pronto.
///
/// Status desconhecido cai num visual neutro em vez de estourar: um APK antigo
/// diante de um estado novo precisa continuar utilizável.
class StatusPill extends StatelessWidget {
  const StatusPill({super.key, required this.status, this.compact = false});

  final OrderStatus status;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final colors = context.statusColors;
    final (fg, bg) = switch (status) {
      OrderStatus.inProgress => (colors.info, colors.infoContainer),
      OrderStatus.assigned => (colors.warning, colors.warningContainer),
      OrderStatus.completed => (colors.success, colors.successContainer),
      OrderStatus.cancelled => (colors.danger, colors.dangerContainer),
      OrderStatus.pending => (colors.neutral, colors.neutralContainer),
      OrderStatus.unknown => (colors.neutral, colors.neutralContainer),
    };

    return Container(
      padding: EdgeInsets.symmetric(
        horizontal: compact ? AlfaSpacing.sm : AlfaSpacing.md,
        vertical: compact ? 2 : AlfaSpacing.xs,
      ),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(AlfaRadius.pill),
      ),
      child: Text(
        status.label,
        style: TextStyle(
          color: fg,
          fontSize: compact ? 11 : 12,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

/// Destaque de prioridade — só para o que foge do normal.
///
/// Pintar todas as prioridades faria o urgente deixar de saltar, que é a única
/// coisa que este elemento precisa fazer.
class PriorityBadge extends StatelessWidget {
  const PriorityBadge({super.key, required this.priority});

  final OrderPriority priority;

  @override
  Widget build(BuildContext context) {
    if (!priority.isElevated) return const SizedBox.shrink();
    final colors = context.statusColors;
    final urgent = priority == OrderPriority.urgent;

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AlfaSpacing.sm,
        vertical: 2,
      ),
      decoration: BoxDecoration(
        color: urgent ? colors.dangerContainer : colors.warningContainer,
        borderRadius: BorderRadius.circular(AlfaRadius.pill),
      ),
      child: Text(
        priority.label,
        style: TextStyle(
          color: urgent ? colors.danger : colors.warning,
          fontSize: 11,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}
