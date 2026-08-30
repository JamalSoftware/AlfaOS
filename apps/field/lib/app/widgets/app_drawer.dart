import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../providers.dart';
import '../theme/tokens.dart';

/// Gaveta global — a mesma em toda tela, alcançável de qualquer ponto do app
/// (PRD §255).
///
/// ## Só o que existe entra aqui
///
/// O PRD §256 fixou a regra: **"item planejado não vira item cinza"**. Um menu
/// com linhas desabilitadas para Escala, Contratos, Estoque, Ferramentas e
/// Rede — todos `PLANNED`, sem uma linha de código — ensinaria o técnico a
/// ignorar o menu inteiro. Quando cada pilar ganhar tela, ele entra aqui; até
/// lá, a ausência é honesta.
///
/// Duas categorias hoje, porque são as duas que têm algo atrás: OPERACIONAL (o
/// dia do técnico) e CONTA (ele mesmo). CLIENTES, MEU TRABALHO e REDE — do
/// desenho do §256 — voltam quando os pilares correspondentes existirem.
class AppDrawer extends ConsumerWidget {
  const AppDrawer({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final session = ref.watch(sessionControllerProvider).session;

    return Drawer(
      child: SafeArea(
        child: ListView(
          padding: EdgeInsets.zero,
          children: [
            if (session != null)
              DrawerHeader(
                margin: EdgeInsets.zero,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    Text(
                      session.userName,
                      style: theme.textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    if (session.companyName.isNotEmpty) ...[
                      const SizedBox(height: 2),
                      Text(
                        session.companyName,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            const _CategoryLabel('OPERACIONAL'),
            _DrawerItem(
              key: const Key('drawer-inicio'),
              icon: Icons.home_outlined,
              label: 'Início',
              onTap: () => _goAndClose(context, '/inicio'),
            ),
            _DrawerItem(
              key: const Key('drawer-orders'),
              icon: Icons.assignment_outlined,
              label: 'Ordens de Serviço',
              onTap: () => _goAndClose(context, '/orders'),
            ),
            _DrawerItem(
              key: const Key('drawer-jornada'),
              icon: Icons.schedule_outlined,
              label: 'Minha Jornada',
              onTap: () => _goAndClose(context, '/jornada'),
            ),
            _DrawerItem(
              key: const Key('drawer-notifications'),
              icon: Icons.notifications_outlined,
              label: 'Notificações',
              onTap: () => _pushAndClose(context, '/notifications'),
            ),
            const Divider(),
            const _CategoryLabel('CONTA'),
            _DrawerItem(
              key: const Key('drawer-settings'),
              icon: Icons.settings_outlined,
              label: 'Configurações',
              onTap: () => _pushAndClose(context, '/settings'),
            ),
            _DrawerItem(
              key: const Key('drawer-logout'),
              icon: Icons.logout_outlined,
              label: 'Sair',
              onTap: () {
                Scaffold.of(context).closeDrawer();
                ref.read(sessionControllerProvider.notifier).logout();
              },
            ),
          ],
        ),
      ),
    );
  }

  /// Destinos da barra principal: `go`, para não empilhar a mesma aba de novo
  /// por cima dela mesma.
  ///
  /// Fecha pelo `Scaffold`, não por `Navigator.pop`: a gaveta não é uma rota
  /// empilhada, é um painel do `Scaffold` que a possui — usar `pop` aqui
  /// fecharia a TELA de baixo (quando havia uma para fechar) em vez da gaveta.
  static void _goAndClose(BuildContext context, String location) {
    Scaffold.of(context).closeDrawer();
    context.go(location);
  }

  /// Destinos fora da barra: `push`, para o back voltar para onde a gaveta foi
  /// aberta — a mesma navegação que o header e as telas já usam.
  static void _pushAndClose(BuildContext context, String location) {
    Scaffold.of(context).closeDrawer();
    context.push(location);
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
        AlfaSpacing.md,
        AlfaSpacing.lg,
        AlfaSpacing.xs,
      ),
      child: Text(
        text,
        style: theme.textTheme.labelSmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
          letterSpacing: 0.8,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

class _DrawerItem extends StatelessWidget {
  const _DrawerItem({
    super.key,
    required this.icon,
    required this.label,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ListTile(leading: Icon(icon), title: Text(label), onTap: onTap);
  }
}
