import 'package:flutter/material.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/widgets/status_pill.dart';
import '../domain/service_order.dart';

/// Card da fila.
///
/// Mostra o **essencial e nada mais**: número, status, prioridade, cliente e
/// onde é. Sem `externalId`, sem provedor, sem CPF, sem dado administrativo —
/// nada disso ajuda a decidir para onde ir agora, e o backend nem os envia.
class OrderCard extends StatelessWidget {
  const OrderCard({super.key, required this.order, required this.onTap});

  final OrderSummary order;
  final VoidCallback onTap;

  static String _formatSchedule(DateTime when) {
    final now = DateTime.now();
    final sameDay =
        when.year == now.year && when.month == now.month && when.day == now.day;
    final hh = when.hour.toString().padLeft(2, '0');
    final mm = when.minute.toString().padLeft(2, '0');
    if (sameDay) return 'Hoje, $hh:$mm';
    final dd = when.day.toString().padLeft(2, '0');
    final mo = when.month.toString().padLeft(2, '0');
    return '$dd/$mo, $hh:$mm';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final location = order.locationLabel;

    return Card(
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AlfaRadius.lg),
        child: Padding(
          padding: const EdgeInsets.all(AlfaSpacing.lg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text(
                    'OS Nº ${order.number}',
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(width: AlfaSpacing.sm),
                  PriorityBadge(priority: order.priority),
                  const Spacer(),
                  StatusPill(status: order.status, compact: true),
                ],
              ),
              const SizedBox(height: AlfaSpacing.sm),
              Text(
                order.customerName,
                style: theme.textTheme.bodyLarge?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              const SizedBox(height: AlfaSpacing.xs),
              Text(
                order.subtype == null || order.subtype!.isEmpty
                    ? order.type
                    : '${order.type} · ${order.subtype}',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              // Cada linha abaixo só aparece se o dado existir. Campo vazio não
              // vira "—" nem espaço estranho.
              if (location != null || order.scheduledAt != null) ...[
                const SizedBox(height: AlfaSpacing.md),
                Wrap(
                  spacing: AlfaSpacing.md,
                  runSpacing: AlfaSpacing.xs,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    if (location != null)
                      _MetaChip(
                        icon: order.hasLocation
                            ? Icons.place_outlined
                            : Icons.location_off_outlined,
                        label: location,
                      ),
                    if (order.scheduledAt != null)
                      _MetaChip(
                        icon: Icons.schedule_outlined,
                        label: _formatSchedule(order.scheduledAt!),
                      ),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _MetaChip extends StatelessWidget {
  const _MetaChip({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 15, color: theme.colorScheme.onSurfaceVariant),
        const SizedBox(width: AlfaSpacing.xs),
        Text(
          label,
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      ],
    );
  }
}
