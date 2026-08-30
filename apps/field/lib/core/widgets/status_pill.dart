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
        // Papel do tema, não tamanho solto: assim o chip acompanha a escala de
        // texto do aparelho em vez de ficar minúsculo para quem aumentou a
        // fonte — justamente quem mais precisa lê-lo.
        style: Theme.of(context).textTheme.labelMedium?.copyWith(color: fg),
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
        // Mesmo papel do `StatusPill`: os dois selos vivem lado a lado no card
        // da OS, e tamanhos diferentes fariam um parecer mais importante que o
        // outro sem que ninguém tivesse decidido isso.
        style: Theme.of(context).textTheme.labelMedium?.copyWith(
          color: urgent ? colors.danger : colors.warning,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}
