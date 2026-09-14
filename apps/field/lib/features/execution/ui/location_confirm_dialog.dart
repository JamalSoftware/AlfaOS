import 'package:flutter/material.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/location/location_service.dart';
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
/// Três desfechos, e cada um diz o que fazer, sem pedir que o técnico
/// interprete regra:
///
/// - **dentro do limite:** a distância e a precisão, e a pergunta de sempre
///   ("Você está no endereço do cliente?"), com Confirmar;
/// - **longe:** a distância e a orientação ("Use Corrigir localização"), com o
///   botão que leva direto para lá — e SEM Confirmar;
/// - **sem GPS:** o motivo, e nenhuma confirmação. Antes da RC-1C a
///   confirmação acontecia assim mesmo; o dono decidiu que não.
///
/// A coordenada do cliente não aparece: o técnico precisa da distância, não
/// de números (a navegação continua pelos links de mapa da OS).
class ConfirmLocationDialog extends StatelessWidget {
  const ConfirmLocationDialog({super.key, required this.check});

  final ConfirmLocationCheck check;

  @override
  Widget build(BuildContext context) {
    if (!check.hasPosition) return _semGps(context);
    if (!check.withinLimit) return _longe(context);
    return _perto(context);
  }

  Widget _medidas(BuildContext context) {
    final destaque = Theme.of(context).textTheme.bodyLarge
        ?.copyWith(fontWeight: FontWeight.w600);
    final precisao = check.position?.accuracyMeters;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Distância da sua posição: '
          '${formatDistanceMeters(check.distanceMeters!)}',
          key: const Key('confirm-location-distance'),
          style: destaque,
        ),
        const SizedBox(height: AlfaSpacing.xs),
        Text(
          precisao != null
              ? 'Precisão do GPS: $precisao m'
              : 'Precisão do GPS: não informada',
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

  /// O motivo, com a saída de cada recusa.
  ///
  /// Não reaproveita `LocationReading.message`: aquela frase foi escrita para o
  /// check-in, que acontece sem GPS, e termina com "você pode continuar sem
  /// ela" — o oposto do que vale aqui.
  static String _motivo(LocationOutcome outcome) => switch (outcome) {
    LocationOutcome.permissionDenied =>
      'A permissão de localização não foi concedida.',
    LocationOutcome.permissionDeniedForever =>
      'A permissão de localização está bloqueada. Libere nas configurações '
          'do aparelho.',
    LocationOutcome.serviceDisabled => 'O GPS do aparelho está desligado.',
    LocationOutcome.unavailable ||
    LocationOutcome.ok => 'Não foi possível obter a localização agora.',
  };

  Widget _semGps(BuildContext context) {
    return AlertDialog(
      title: const Text('Sem a sua localização'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(_motivo(check.reading.outcome)),
            const SizedBox(height: AlfaSpacing.md),
            const Text(
              'Sem a posição do aparelho não é possível confirmar o ponto.',
              key: Key('confirm-location-no-gps'),
            ),
          ],
        ),
      ),
      actions: [
        FilledButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Fechar'),
        ),
      ],
    );
  }
}
