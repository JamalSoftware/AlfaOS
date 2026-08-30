import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../providers.dart';
import '../theme/tokens.dart';
import 'planned_module_sheet.dart';
import 'workspace_menu.dart';

/// Gaveta global — a mesma em toda tela, alcançável de qualquer ponto do app
/// (PRD §255).
///
/// ## O que ela mostra, e por quê
///
/// O mapa do Technician Workspace inteiro (§256, revisada depois do primeiro
/// piloto físico): o que já funciona **e** o que o AlfaOS pretende cobrir, com
/// o planejado claramente marcado. A regra anterior — "item que não existe não
/// aparece" — deixava o técnico sem noção do produto; a nova mantém a honestia
/// por outro caminho: **planejado nunca aparenta estar pronto**.
///
/// A estrutura é dado, não widget: [workspaceMenu]. Aqui só se desenha.
class AppDrawer extends ConsumerWidget {
  const AppDrawer({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionControllerProvider).session;
    // Rota atual, para marcar o destino ativo. `null` fora de rota conhecida.
    final location = GoRouterState.of(context).matchedLocation;

    return Drawer(
      child: SafeArea(
        child: Column(
          children: [
            _DrawerHeader(
              name: session?.userName ?? '',
              company: session?.companyName ?? '',
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.only(bottom: AlfaSpacing.lg),
                children: [
                  for (final section in workspaceMenu) ...[
                    _CategoryLabel(section.category.label),
                    for (final item in section.items)
                      _DrawerItem(
                        item: item,
                        selected: item.route != null && item.route == location,
                        onTap: () => _handle(context, ref, item),
                      ),
                    const SizedBox(height: AlfaSpacing.sm),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// Fecha a gaveta e executa a ação do item.
  ///
  /// Fecha pelo `Scaffold`, não por `Navigator.pop`: a gaveta não é uma rota
  /// empilhada, é um painel do `Scaffold` que a possui — usar `pop` aqui
  /// fecharia a TELA de baixo em vez da gaveta.
  ///
  /// O `switch` é exaustivo sobre [WorkspaceItemAction] de propósito: uma ação
  /// nova no enum quebra a compilação aqui, em vez de cair silenciosamente num
  /// `default` que não faz nada.
  static void _handle(BuildContext context, WidgetRef ref, WorkspaceItem item) {
    Scaffold.of(context).closeDrawer();

    switch (item.action) {
      case WorkspaceItemAction.goBranch:
        // Destino da barra principal: `go`, para não empilhar a mesma aba
        // por cima dela mesma.
        context.go(item.route!);
      case WorkspaceItemAction.push:
        // Fora da barra: `push`, para o back voltar de onde veio.
        context.push(item.route!);
      case WorkspaceItemAction.planned:
        // Nenhuma rota. A folha é local e não entra no histórico.
        showPlannedModuleSheet(context, item.label);
      case WorkspaceItemAction.logout:
        ref.read(sessionControllerProvider.notifier).logout();
    }
  }
}

/// Cabeçalho com identidade — iniciais, nome e empresa.
///
/// **Nada é inventado.** Não há "Técnico de Campo" nem cargo fabricado: a
/// sessão do Field não traz papel, e escrever um seria afirmar algo que o
/// servidor não disse. O que aparece é o que `/me` entrega (§254): nome e
/// empresa. Sem nome, o bloco de identidade some inteiro em vez de mostrar um
/// avatar vazio.
class _DrawerHeader extends StatelessWidget {
  const _DrawerHeader({required this.name, required this.company});

  final String name;
  final String company;

  /// Até duas iniciais, do primeiro e do último nome.
  static String _initials(String value) {
    final parts = value
        .trim()
        .split(RegExp(r'\s+'))
        .where((p) => p.isNotEmpty)
        .toList();
    if (parts.isEmpty) return '';
    if (parts.length == 1) return parts.first.characters.first.toUpperCase();
    return (parts.first.characters.first + parts.last.characters.first)
        .toUpperCase();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    if (name.isEmpty) {
      return const SizedBox(height: AlfaSpacing.lg);
    }

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(
        AlfaSpacing.lg,
        AlfaSpacing.xl,
        AlfaSpacing.lg,
        AlfaSpacing.lg,
      ),
      decoration: BoxDecoration(color: scheme.primaryContainer),
      child: Row(
        children: [
          CircleAvatar(
            radius: 24,
            backgroundColor: scheme.primary,
            child: Text(
              _initials(name),
              style: TextStyle(
                color: scheme.onPrimary,
                fontWeight: FontWeight.w700,
                fontSize: 16,
              ),
            ),
          ),
          const SizedBox(width: AlfaSpacing.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  name,
                  style: theme.textTheme.titleMedium?.copyWith(
                    color: scheme.onPrimaryContainer,
                    fontWeight: FontWeight.w700,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                if (company.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(
                    company,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: scheme.onPrimaryContainer.withValues(alpha: 0.8),
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _CategoryLabel extends StatelessWidget {
  const _CategoryLabel(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AlfaSpacing.lg,
        AlfaSpacing.lg,
        AlfaSpacing.lg,
        AlfaSpacing.xs,
      ),
      child: Text(
        text,
        style: theme.textTheme.labelSmall?.copyWith(
          color: theme.colorScheme.primary,
          letterSpacing: 0.8,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

/// Uma linha da gaveta.
///
/// Três estados visuais, e o do meio é o que o piloto pediu: o **ativo** deixa
/// de ser um bloco cinza pesado e passa a ter faixa lateral e fundo tonal
/// leve, com ícone e rótulo em `primary`. O **planejado** ganha o selo
/// `EM BREVE` — texto, não só opacidade, porque cor e transparência sozinhas
/// não são sinal (§46 do escopo, e a mesma regra do `StatusPill`).
class _DrawerItem extends StatelessWidget {
  const _DrawerItem({
    required this.item,
    required this.selected,
    required this.onTap,
  });

  final WorkspaceItem item;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    final foreground = selected
        ? scheme.primary
        : item.isPlanned
        ? scheme.onSurfaceVariant
        : scheme.onSurface;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AlfaSpacing.sm),
      child: Material(
        color: selected ? scheme.primaryContainer : Colors.transparent,
        borderRadius: BorderRadius.circular(AlfaRadius.md),
        child: InkWell(
          key: Key(item.testKey),
          onTap: onTap,
          borderRadius: BorderRadius.circular(AlfaRadius.md),
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AlfaSpacing.md,
              vertical: AlfaSpacing.md,
            ),
            child: Row(
              children: [
                // Faixa lateral: o acento do item ativo, sem o bloco pesado.
                Container(
                  width: 3,
                  height: 20,
                  margin: const EdgeInsets.only(right: AlfaSpacing.md),
                  decoration: BoxDecoration(
                    color: selected ? scheme.primary : Colors.transparent,
                    borderRadius: BorderRadius.circular(AlfaRadius.pill),
                  ),
                ),
                Icon(item.icon, size: 22, color: foreground),
                const SizedBox(width: AlfaSpacing.md),
                Expanded(
                  child: Text(
                    item.label,
                    style: theme.textTheme.bodyLarge?.copyWith(
                      color: foreground,
                      fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                if (item.isPlanned) const _PlannedTag(),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// O selo do módulo planejado. **Texto**, não só uma cor mais fraca.
class _PlannedTag extends StatelessWidget {
  const _PlannedTag();

  @override
  Widget build(BuildContext context) {
    final colors = context.statusColors;
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AlfaSpacing.sm,
        vertical: 2,
      ),
      decoration: BoxDecoration(
        color: colors.neutralContainer,
        borderRadius: BorderRadius.circular(AlfaRadius.pill),
      ),
      child: Text(
        'EM BREVE',
        style: TextStyle(
          color: colors.neutral,
          fontSize: 10,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.4,
        ),
      ),
    );
  }
}
