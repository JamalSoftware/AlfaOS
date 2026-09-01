import 'package:flutter/material.dart';

import '../../app/theme/tokens.dart';

/// O aviso de que a ordem na tela é do APLICATIVO, não do despacho.
///
/// ## Por que ele existe
///
/// Quando o servidor não oferece a fila (APK novo contra servidor anterior à
/// DQ-5), o Field volta a ordenar sozinho por `attentionOrders`. O fallback é
/// legítimo: sem ele o técnico ficaria sem lista nenhuma durante o rollout.
///
/// O que não é legítimo é ele ser **silencioso**. Uma sequência calculada
/// localmente, mostrada com a mesma cara da sequência que o despachante
/// definiu, faz o técnico atender na ordem errada com a certeza de estar
/// certo. O aviso é o que separa as duas coisas na tela, do mesmo jeito que o
/// `unavailable` as separa no estado.
///
/// ## E por que ele é discreto
///
/// Não é erro nem alarme: nada falhou, e não há o que o técnico faça a
/// respeito. É uma etiqueta de procedência, e o peso visual de uma.
class LocalOrderNote extends StatelessWidget {
  const LocalOrderNote({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    return Container(
      key: const Key('local-order-note'),
      margin: const EdgeInsets.only(bottom: AlfaSpacing.md),
      padding: const EdgeInsets.symmetric(
        horizontal: AlfaSpacing.md,
        vertical: AlfaSpacing.sm,
      ),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(AlfaRadius.sm),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.info_outline, size: 16, color: scheme.onSurfaceVariant),
          const SizedBox(width: AlfaSpacing.sm),
          Expanded(
            child: Text(
              'Ordem sugerida pelo aplicativo. Seu servidor ainda não define '
              'a fila do despacho.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: scheme.onSurfaceVariant,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
