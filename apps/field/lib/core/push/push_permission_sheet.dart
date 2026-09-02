import 'package:flutter/material.dart';

import '../../app/theme/tokens.dart';

/// A explicação antes da pergunta do sistema (`NF-2`).
///
/// Uma folha, no padrão que a gaveta já usa. **Não é onboarding**: não tem
/// passo, não tem ilustração e não tem segunda tela. Ela existe para que o
/// diálogo do Android chegue com contexto — pedido sem contexto é recusado, e
/// no Android a recusa é lembrada.
///
/// O `FIELD DESIGN FREEZE` está ativo, então nada aqui inventa componente: são
/// os mesmos tokens de espaçamento, a mesma tipografia e o mesmo par de ações
/// do resto do aplicativo.
///
/// Devolve `true` quando a pessoa quer ativar.
Future<bool> showPushPermissionSheet(BuildContext context) async {
  final escolha = await showModalBottomSheet<bool>(
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
            key: const Key('push-permission-sheet'),
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(
                    Icons.notifications_active_outlined,
                    color: theme.colorScheme.primary,
                  ),
                  const SizedBox(width: AlfaSpacing.md),
                  Expanded(
                    child: Text(
                      'Avisos de campo',
                      style: theme.textTheme.titleLarge?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: AlfaSpacing.lg),
              Text(
                'Ative as notificações para receber novas ordens de serviço e '
                'avisos enquanto estiver em campo.',
                style: theme.textTheme.bodyLarge,
              ),
              const SizedBox(height: AlfaSpacing.sm),
              Text(
                'Sem elas o aplicativo continua funcionando: os avisos ficam '
                'no sino, e você os vê ao abrir.',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: AlfaSpacing.xl),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    key: const Key('push-permission-later'),
                    onPressed: () => Navigator.of(sheetContext).pop(false),
                    child: const Text('AGORA NÃO'),
                  ),
                  const SizedBox(width: AlfaSpacing.sm),
                  FilledButton(
                    key: const Key('push-permission-enable'),
                    onPressed: () => Navigator.of(sheetContext).pop(true),
                    child: const Text('ATIVAR'),
                  ),
                ],
              ),
            ],
          ),
        ),
      );
    },
  );
  // Dispensar a folha arrastando é "agora não", e não uma pergunta pendente.
  return escolha ?? false;
}
