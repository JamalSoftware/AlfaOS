import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'providers.dart';
import 'shell_back.dart';
import 'widgets/app_drawer.dart';

/// Casca do App Shell: três destinos, sempre visíveis (PRD §255).
///
/// **Início, OS e Jornada** — as duas ações mais frequentes do dia (OS,
/// Jornada) mais a tela que responde "o que eu faço agora" (Início). Um
/// quarto destino "Mapa" foi cogitado, mas o PRD §255 proíbe destino morto na
/// barra enquanto o módulo não existe: "fica vago ou traz Agenda". Nenhum dos
/// dois substitutos tem código nesta fase, então a barra fica com três — o
/// próprio §255 antecipou esse caso.
///
/// Notificações e Configurações não são mais abas: a §255 já as descrevia como
/// superfície de cabeçalho (sino) e item de gaveta, não destino de trabalho —
/// e cada tela alcança as duas por ali, não por uma quarta posição na barra.
///
/// ## A gaveta é DESTE `Scaffold`, e só dele
///
/// Cada branch (Início, OS, Jornada) tem o próprio `Scaffold` para manter
/// AppBar e título independentes — mas só UM `Scaffold` possui a `Drawer`
/// de verdade: este. Se cada branch também a possuísse, ela nasceria aninhada
/// dentro do espaço que este `Scaffold` já reduziu para caber a
/// `NavigationBar`, e o último item da gaveta colidiria com a barra. As telas
/// abrem ESTA gaveta por referência (`shellScaffoldKeyProvider`), no toque do
/// próprio hambúrguer.
class HomeShell extends ConsumerWidget {
  const HomeShell({super.key, required this.navigationShell});

  final StatefulNavigationShell navigationShell;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scaffoldKey = ref.watch(shellScaffoldKeyProvider);

    /*
      O VOLTAR do Android (DQ-6).

      Trocar de aba num `indexedStack` não empilha rota. Sem pilha para
      desempilhar, o pop chegava ao sistema e o aplicativo FECHAVA — o técnico
      apertava Voltar em `OS` esperando o `Início` e via o app sumir.

      `canPop` responde a pergunta do sistema ANTES do gesto: só o Início, sem
      nada aberto por cima, autoriza sair. Nos outros casos interceptamos e
      navegamos.

      A gaveta é lida do `Scaffold` no momento do gesto, e não de estado
      próprio: ela abre sem reconstruir esta casca, e um espelho local
      dessincronizaria na primeira vez que alguém a fechasse arrastando.
    */
    bool drawerOpen() => scaffoldKey.currentState?.isDrawerOpen ?? false;

    return PopScope(
      canPop:
          resolveShellBack(
            branchIndex: navigationShell.currentIndex,
            drawerOpen: drawerOpen(),
          ) ==
          ShellBackAction.exitApp,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        switch (resolveShellBack(
          branchIndex: navigationShell.currentIndex,
          drawerOpen: drawerOpen(),
        )) {
          case ShellBackAction.closeDrawer:
            scaffoldKey.currentState?.closeDrawer();
          case ShellBackAction.goHome:
            navigationShell.goBranch(homeBranchIndex);
          case ShellBackAction.exitApp:
            // `canPop` já teria autorizado; chegar aqui significa que o estado
            // mudou entre o build e o gesto. Não force a saída.
            break;
        }
      },
      child: Scaffold(
        key: scaffoldKey,
        drawer: const AppDrawer(),
        body: navigationShell,
        bottomNavigationBar: NavigationBar(
          selectedIndex: navigationShell.currentIndex,
          onDestinationSelected: (index) => navigationShell.goBranch(
            index,
            // Tocar na aba já ativa volta ao topo dela, em vez de não fazer nada.
            initialLocation: index == navigationShell.currentIndex,
          ),
          destinations: const [
            NavigationDestination(
              icon: Icon(Icons.home_outlined),
              selectedIcon: Icon(Icons.home),
              label: 'Início',
            ),
            NavigationDestination(
              icon: Icon(Icons.assignment_outlined),
              selectedIcon: Icon(Icons.assignment),
              label: 'OS',
            ),
            NavigationDestination(
              icon: Icon(Icons.schedule_outlined),
              selectedIcon: Icon(Icons.schedule),
              label: 'Jornada',
            ),
          ],
        ),
      ),
    );
  }
}
