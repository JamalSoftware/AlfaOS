import 'package:flutter/material.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/location/operational_position.dart';
import '../domain/location_confirm.dart';

/// O que o técnico escolheu no diálogo de confirmação.
enum ConfirmLocationChoice {
  /// Confirmar o ponto — só oferecido dentro do limite.
  confirm,

  /// Ir para "Corrigir localização" — a saída quando está longe.
  correct,
}

/// O diálogo de "Confirmar localização" — RC-1C.
///
/// Dois desfechos, e cada um diz o que fazer, sem pedir que o técnico
/// interprete regra:
///
/// - **dentro do limite:** a distância e a precisão, e a pergunta de sempre
///   ("Você está no endereço do cliente?"), com Confirmar;
/// - **longe:** a distância e a orientação ("Use Corrigir localização"), com o
///   botão que leva direto para lá — e SEM Confirmar.
///
/// Sem GPS, ou com GPS impreciso, este diálogo nem abre (RC-1C-HOTFIX): a
/// captura (`LocationFixDialog`) diz o motivo e deixa tentar de novo, e só
/// uma posição dentro do contrato chega até aqui.
///
/// A coordenada do cliente não aparece: o técnico precisa da distância, não
/// de números (a navegação continua pelos links de mapa da OS).
class ConfirmLocationDialog extends StatelessWidget {
  const ConfirmLocationDialog({super.key, required this.check});

  final ConfirmLocationCheck check;

  @override
  Widget build(BuildContext context) {
    if (!check.withinLimit) return _longe(context);
    return _perto(context);
  }

  Widget _medidas(BuildContext context) {
    final destaque = Theme.of(context).textTheme.bodyLarge
        ?.copyWith(fontWeight: FontWeight.w600);
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Distância da sua posição: '
          '${formatDistanceMeters(check.distanceMeters)}',
          key: const Key('confirm-location-distance'),
          style: destaque,
        ),
        const SizedBox(height: AlfaSpacing.xs),
        Text(
          'Precisão do GPS: ${formatAccuracyMeters(check.fix.accuracyMeters)}',
          key: const Key('confirm-location-accuracy'),
        ),
      ],
    );
  }

  Widget _perto(BuildContext context) {
    return AlertDialog(
      title: const Text('Você está no endereço do cliente?'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _medidas(context),
            const SizedBox(height: AlfaSpacing.md),
            const Text(
              'Confirmar registra que este ponto foi conferido em campo. '
              'O ponto não é movido.',
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancelar'),
        ),
        FilledButton(
          key: const Key('confirm-location-submit'),
          onPressed: () =>
              Navigator.of(context).pop(ConfirmLocationChoice.confirm),
          child: const Text('Confirmar'),
        ),
      ],
    );
  }

  Widget _longe(BuildContext context) {
    return AlertDialog(
      title: const Text('Longe do ponto cadastrado'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _medidas(context),
            const SizedBox(height: AlfaSpacing.md),
            const Text(
              'Você está muito distante do ponto cadastrado. '
              'Use Corrigir localização.',
              key: Key('confirm-location-too-far'),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Fechar'),
        ),
        FilledButton.icon(
          key: const Key('confirm-location-go-correct'),
          onPressed: () =>
              Navigator.of(context).pop(ConfirmLocationChoice.correct),
          icon: const Icon(Icons.edit_location_alt_outlined),
          label: const Text('Corrigir localização'),
        ),
      ],
    );
  }
}
