import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';

/// O hambúrguer de cada tela — abre a gaveta do App SHELL, não uma própria.
///
/// Cada tela da barra principal tem o próprio `Scaffold` (para manter AppBar e
/// título independentes), então `Scaffold.of(context).openDrawer()` chamado
/// DAQUI resolveria para o `Scaffold` ERRADO — o da própria tela, não o do
/// shell. Este botão abre a gaveta pela referência guardada em
/// `shellScaffoldKeyProvider`, que é a única `Drawer` que existe de verdade
/// (`HomeShell`).
class ShellDrawerButton extends ConsumerWidget {
  const ShellDrawerButton({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return IconButton(
      icon: const Icon(Icons.menu),
      tooltip: 'Abrir menu',
      onPressed: () =>
          ref.read(shellScaffoldKeyProvider).currentState?.openDrawer(),
    );
  }
}
