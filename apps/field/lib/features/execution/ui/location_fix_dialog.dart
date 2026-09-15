import 'dart:async';

import 'package:flutter/material.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/location/operational_position.dart';

/// Uma captura de posição, do jeito que a tela a dispara.
typedef FixAcquisition = Future<OperationalFixResult> Function({
  void Function(double accuracyMeters)? onReading,
  Future<void>? cancel,
});

/// "Buscando uma localização precisa…" — RC-1C-HOTFIX.
///
/// Abre a captura e só fecha com uma posição DENTRO do contrato (devolvida),
/// ou com o técnico desistindo (`null`). Uma falha não fecha o diálogo: ela
/// diz o motivo e oferece tentar de novo, que abre uma captura NOVA — nada da
/// anterior é reaproveitado.
///
/// Antes da hotfix não existia este estado: corrigir lia o GPS sem nada na
/// tela, por até 15 s, e a seção continuava mostrando o que era antes.
Future<OperationalFix?> showLocationFixDialog(
  BuildContext context, {
  required FixAcquisition acquire,
  required double maxAccuracyMeters,
}) {
  return showDialog<OperationalFix>(
    context: context,
    // Um toque fora não pode cancelar sem querer uma espera de 20 s; o
    // "Cancelar" e o voltar do sistema continuam fechando.
    barrierDismissible: false,
    builder: (_) => LocationFixDialog(
      acquire: acquire,
      maxAccuracyMeters: maxAccuracyMeters,
    ),
  );
}

class LocationFixDialog extends StatefulWidget {
  const LocationFixDialog({
    super.key,
    required this.acquire,
    required this.maxAccuracyMeters,
  });

  final FixAcquisition acquire;
  final double maxAccuracyMeters;

  @override
  State<LocationFixDialog> createState() => _LocationFixDialogState();
}

class _LocationFixDialogState extends State<LocationFixDialog> {
  /// O cancelamento da captura EM CURSO. Trocado a cada tentativa: a
  /// resposta de uma captura antiga não tem mais o que fazer nesta tela.
  Completer<void>? _cancel;
  double? _atual;
  OperationalFixFailed? _falha;

  @override
  void initState() {
    super.initState();
    _iniciar();
  }

  @override
  void dispose() {
    // Voltar do sistema fecha o diálogo: a captura não pode seguir medindo.
    _cancelarCaptura();
    super.dispose();
  }

  void _cancelarCaptura() {
    final cancel = _cancel;
    if (cancel != null && !cancel.isCompleted) cancel.complete();
  }

  Future<void> _iniciar() async {
    _cancelarCaptura();
    final cancel = Completer<void>();
    _cancel = cancel;
    final resultado = await widget.acquire(
      cancel: cancel.future,
      onReading: (precisao) {
        if (mounted && identical(_cancel, cancel)) {
          setState(() => _atual = precisao);
        }
      },
    );
    if (!mounted || !identical(_cancel, cancel)) return;
    switch (resultado) {
      case OperationalFixAcquired(:final fix):
        Navigator.of(context).pop(fix);
      case OperationalFixFailed(reason: OperationalFixFailure.cancelled):
        break;
      case OperationalFixFailed():
        setState(() => _falha = resultado);
    }
  }

  void _tentarDeNovo() {
    setState(() {
      _falha = null;
      _atual = null;
    });
    _iniciar();
  }

  void _desistir() {
    _cancelarCaptura();
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final falha = _falha;
    return falha == null ? _buscando(context) : _falhou(context, falha);
  }

  Widget _buscando(BuildContext context) {
    final atual = _atual;
    return AlertDialog(
      title: const Text('Buscando uma localização precisa…'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const LinearProgressIndicator(),
            const SizedBox(height: AlfaSpacing.md),
            if (atual != null) ...[
              Text(
                'Precisão atual: ${formatAccuracyMeters(atual)}',
                key: const Key('fix-current-accuracy'),
                style: Theme.of(context).textTheme.bodyLarge
                    ?.copyWith(fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: AlfaSpacing.xs),
            ],
            Text(
              'Precisão necessária: até '
              '${formatAccuracyMeters(widget.maxAccuracyMeters)}.',
              key: const Key('fix-required-accuracy'),
            ),
            const SizedBox(height: AlfaSpacing.sm),
            const Text(
              'Fique parado, de preferência em um local aberto. Isso pode '
              'levar alguns segundos.',
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          key: const Key('fix-cancel'),
          onPressed: _desistir,
          child: const Text('Cancelar'),
        ),
      ],
    );
  }

  Widget _falhou(BuildContext context, OperationalFixFailed falha) {
    return AlertDialog(
      title: Text(falha.title),
      content: SingleChildScrollView(
        child: Text(falha.message ?? '', key: const Key('fix-failure-message')),
      ),
      actions: [
        TextButton(
          key: const Key('fix-close'),
          onPressed: _desistir,
          child: const Text('Fechar'),
        ),
        FilledButton(
          key: const Key('fix-retry'),
          onPressed: _tentarDeNovo,
          child: const Text('Tentar novamente'),
        ),
      ],
    );
  }
}
