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
/// existe uma segunda contagem inventada para o cabeçalho, e **nada aqui soma**:
/// o número é sempre o que o backend respondeu na última leitura.
///
/// ## A regra antiga foi revista pelo piloto (`NF-5`)
///
/// Este comentário dizia que ficar em zero até a tela de notificações ser
/// visitada era honesto, e que buscar em segundo plano só para alimentar um
/// badge gastaria bateria e dados "antes de o push real existir (§153)".
///
/// O push real passou a existir. Com ele, a mesma regra deixou de ser honesta e
/// virou o defeito: o aviso chegava ao aparelho, o técnico abria o aplicativo e
/// o sino continuava em zero — dizendo, com número, que não havia nada. Quem
/// carrega agora é a sessão (`app.dart`), uma vez por autenticação.
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
