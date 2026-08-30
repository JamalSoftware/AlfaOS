import 'package:flutter/material.dart';

import '../theme/tokens.dart';

/// A ÚNICA superfície de "módulo em preparação".
///
/// Uma folha, não quinze telas. Cada placeholder com tela própria seria uma
/// rota a manter, um arquivo a revisar e — pior — quinze lugares onde alguém,
/// meses depois, poderia acidentalmente ligar um botão a uma API que não
/// existe. Aqui não há rota nenhuma: a folha é local, some ao ser dispensada e
/// não deixa nada no histórico de navegação.
///
/// O texto é honesto: não promete data, não diz "em breve" como se fosse
/// semana que vem, e não sugere que exista algo por trás. Ele nomeia o módulo
/// para o técnico saber que o AlfaOS pretende cobrir aquilo — que é justamente
/// o que o primeiro piloto físico mostrou faltar (§256, revisada).
Future<void> showPlannedModuleSheet(BuildContext context, String label) {
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    builder: (sheetContext) {
      final theme = Theme.of(sheetContext);
      return SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            AlfaSpacing.xl,
            0,
            AlfaSpacing.xl,
            AlfaSpacing.xl,
          ),
          child: Column(
            key: const Key('planned-module-sheet'),
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(
                    Icons.construction_outlined,
                    color: theme.colorScheme.primary,
                  ),
                  const SizedBox(width: AlfaSpacing.md),
                  Expanded(
                    child: Text(
                      label,
                      style: theme.textTheme.titleLarge?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: AlfaSpacing.lg),
              Text(
                'Módulo em preparação.',
                style: theme.textTheme.titleMedium?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: AlfaSpacing.sm),
              Text(
                'O AlfaOS está sendo preparado para disponibilizar esta '
                'função. Ela ainda não está ativa neste aplicativo.',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: AlfaSpacing.xl),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  key: const Key('planned-module-ack'),
                  onPressed: () => Navigator.of(sheetContext).pop(),
                  child: const Text('ENTENDI'),
                ),
              ),
            ],
          ),
        ),
      );
    },
  );
}
