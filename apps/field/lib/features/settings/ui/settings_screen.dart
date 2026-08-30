import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/providers.dart';
import '../../../app/theme/theme_controller.dart';
import '../../../app/theme/tokens.dart';
import '../../../core/config/env.dart';
import '../../../core/widgets/state_views.dart';

/// Configurações — contexto do técnico, tema e sair.
///
/// Deixou de ser a terceira aba ("Mais") quando o App Shell ganhou barra
/// própria (PRD §255): agora é item de CONTA na gaveta, alcançável de
/// qualquer tela, sem disputar espaço com OS e Jornada.
class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final session = ref.watch(sessionControllerProvider).session;
    final themeMode = ref.watch(themeControllerProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Configurações')),
      body: ListView(
        padding: const EdgeInsets.all(AlfaSpacing.lg),
        children: [
          if (session != null)
            SectionCard(
              title: 'Técnico',
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    session.userName,
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    session.userEmail,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                  if (session.companyName.isNotEmpty) ...[
                    const SizedBox(height: AlfaSpacing.md),
                    Text(
                      session.companyName,
                      style: theme.textTheme.bodyMedium,
                    ),
                  ],
                  /*
                    Elegibilidade vem do servidor, com a frase pronta.

                    Um técnico desativado continua LENDO as OS que já tinha —
                    nada registrado é escondido. O que ele perde é a capacidade
                    de escrever, e a tela explica por quê em vez de mostrar um
                    botão que a API recusaria.
                  */
                  if (session.executionIssue != null) ...[
                    const SizedBox(height: AlfaSpacing.md),
                    _Notice(message: session.executionIssue!),
                  ],
                ],
              ),
            ),
          const SizedBox(height: AlfaSpacing.md),
          SectionCard(
            title: 'Aparência',
            // `RadioGroup` é a API atual: o grupo guarda o valor e o callback,
            // e cada `RadioListTile` só declara o seu. `groupValue`/`onChanged`
            // por item estão depreciados desde a 3.32.
            child: RadioGroup<ThemeMode>(
              groupValue: themeMode,
              onChanged: (value) {
                if (value != null) {
                  ref.read(themeControllerProvider.notifier).setMode(value);
                }
              },
              child: Column(
                children: [
                  for (final mode in ThemeMode.values)
                    RadioListTile<ThemeMode>(
                      key: Key('theme-${ThemeController.encode(mode)}'),
                      value: mode,
                      contentPadding: EdgeInsets.zero,
                      title: Text(ThemeController.label(mode)),
                      subtitle: mode == ThemeMode.system
                          ? const Text('Acompanha o aparelho')
                          : null,
                    ),
                ],
              ),
            ),
          ),
          const SizedBox(height: AlfaSpacing.md),
          SectionCard(
            title: 'Sobre',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('AlfaOS Field — Alpha', style: theme.textTheme.bodyMedium),
                const SizedBox(height: 2),
                Text(
                  // Só o host, nunca token nem caminho de credencial. Ajuda o
                  // suporte a saber contra qual ambiente o aparelho está.
                  Uri.tryParse(Env.apiBaseUrl)?.host ?? '—',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: AlfaSpacing.xl),
          OutlinedButton.icon(
            key: const Key('settings-logout'),
            onPressed: () =>
                ref.read(sessionControllerProvider.notifier).logout(),
            icon: const Icon(Icons.logout_outlined),
            label: const Text('SAIR'),
          ),
        ],
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final colors = context.statusColors;
    return Container(
      padding: const EdgeInsets.all(AlfaSpacing.md),
      decoration: BoxDecoration(
        color: colors.warningContainer,
        borderRadius: BorderRadius.circular(AlfaRadius.sm),
      ),
      child: Text(
        message,
        style: TextStyle(color: colors.warning, fontSize: 13),
      ),
    );
  }
}
