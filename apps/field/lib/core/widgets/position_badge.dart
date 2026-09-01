import 'package:flutter/material.dart';

import '../../app/theme/tokens.dart';

/// A posição da OS na fila: `1ª`, `2ª`, `3ª`.
///
/// ## Por que é um componente, e não um `Text` estilizado
///
/// A posição aparece no Início e em Minhas Ordens. Estilizada em cada lugar,
/// ela divergiria na primeira vez que alguém ajustasse uma das duas — e a
/// mesma informação passaria a ter dois pesos na mesma sessão.
///
/// ## O primeiro lugar pesa mais
///
/// A `1ª` é a única resposta à pergunta "o que eu faço agora". As demais são
/// contexto: ordenam o resto do dia, mas não decidem o próximo passo. Por isso
/// ela ganha a cor de ação, e as outras ficam em superfície neutra — a
/// diferença é de HIERARQUIA, não de alerta.
///
/// O texto carrega a informação inteira (`1ª`, `2ª`), então cor aqui reforça e
/// nunca substitui: em escala de cinza, sob sol, ou para quem não distingue os
/// tons, a leitura continua exata.
class PositionBadge extends StatelessWidget {
  const PositionBadge({super.key, required this.position});

  final int position;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final primeira = position == 1;

    return Container(
      key: Key('position-badge-$position'),
      constraints: const BoxConstraints(minWidth: 34),
      padding: const EdgeInsets.symmetric(
        horizontal: AlfaSpacing.sm,
        vertical: 3,
      ),
      decoration: BoxDecoration(
        color: primeira
            ? theme.colorScheme.primary
            : theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(AlfaRadius.sm),
      ),
      child: Text(
        '$positionª',
        textAlign: TextAlign.center,
        style: theme.textTheme.labelMedium?.copyWith(
          color: primeira
              ? theme.colorScheme.onPrimary
              : theme.colorScheme.onSurface,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}
