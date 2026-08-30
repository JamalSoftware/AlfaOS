import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features/notifications/state/notifications_controller.dart';

/// O sino no cabeçalho — não na barra principal (PRD §255).
///
/// Notificação é superfície de INTERRUPÇÃO, não destino de trabalho: ela não
/// disputa vaga com OS ou Jornada, que são o que o técnico usa o dia inteiro.
///
/// ## O número é real, ou não aparece
///
/// `unreadCount` vem do MESMO estado que a tela de notificações já usa — não
/// existe uma segunda contagem inventada para o cabeçalho. Antes de a tela ser
/// visitada nesta sessão, o contador é zero porque nada foi carregado ainda
/// — não porque exista uma promessa de "zero notificações". Isso é honesto:
/// não fingir número que ninguém verificou é melhor do que buscar em segundo
/// plano só para alimentar um badge, o que gastaria bateria e dados do técnico
/// antes de o push real existir (§153).
class NotificationsBell extends ConsumerWidget {
  const NotificationsBell({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final unread = ref.watch(
      notificationsControllerProvider.select((s) => s.unreadCount),
    );

    return IconButton(
      key: const Key('notifications-bell'),
      tooltip: 'Notificações',
      onPressed: () => context.push('/notifications'),
      icon: Badge(
        isLabelVisible: unread > 0,
        label: Text('$unread'),
        child: const Icon(Icons.notifications_outlined),
      ),
    );
  }
}
