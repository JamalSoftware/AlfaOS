import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/widgets/state_views.dart';
import '../domain/app_notification.dart';
import '../state/notifications_controller.dart';

/// Central de notificações.
///
/// Enquanto o FCM não existe, esta tela é o **único** caminho pelo qual uma
/// atribuição chega ao técnico — não é uma aba decorativa esperando o push.
/// Mesmo depois do FCM ela continua sendo o registro: push depende de token
/// válido, aparelho ligado e um terceiro que pode descartar a mensagem sem
/// avisar.
class NotificationsScreen extends ConsumerStatefulWidget {
  const NotificationsScreen({super.key});

  @override
  ConsumerState<NotificationsScreen> createState() =>
      _NotificationsScreenState();
}

class _NotificationsScreenState extends ConsumerState<NotificationsScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(notificationsControllerProvider.notifier).load();
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(notificationsControllerProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Notificações'),
        actions: [
          if (state.unreadCount > 0)
            TextButton(
              key: const Key('notifications-mark-all'),
              onPressed: () =>
                  ref.read(notificationsControllerProvider.notifier).markRead(),
              child: const Text('MARCAR TODAS'),
            ),
        ],
      ),
      body: RefreshIndicator(
        // Pull-to-refresh, e não polling: consultar em laço gastaria bateria e
        // dados do técnico para um aviso que ele vê ao abrir a aba.
        onRefresh: () =>
            ref.read(notificationsControllerProvider.notifier).load(),
        child: _body(state),
      ),
    );
  }

  Widget _body(NotificationsState state) {
    if (state.loading && state.items.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }

    if (state.error != null && state.items.isEmpty) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          SizedBox(height: MediaQuery.sizeOf(context).height * 0.18),
          ErrorView(
            message: 'Não foi possível carregar as notificações.',
            onRetry: () =>
                ref.read(notificationsControllerProvider.notifier).load(),
          ),
        ],
      );
    }

    if (state.isEmpty) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          SizedBox(height: MediaQuery.sizeOf(context).height * 0.18),
          const EmptyView(
            title: 'Nenhuma notificação.',
            description: 'Você será avisado quando uma OS for atribuída.',
            icon: Icons.notifications_none_outlined,
          ),
        ],
      );
    }

    return ListView.separated(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.symmetric(vertical: AlfaSpacing.sm),
      itemCount: state.items.length,
      separatorBuilder: (_, _) => const Divider(height: 1),
      itemBuilder: (context, index) =>
          _NotificationTile(notification: state.items[index]),
    );
  }
}

class _NotificationTile extends ConsumerWidget {
  const _NotificationTile({required this.notification});

  final AppNotification notification;

  static String _ago(DateTime when) {
    final diff = DateTime.now().difference(when);
    if (diff.inMinutes < 1) return 'agora';
    if (diff.inMinutes < 60) return '${diff.inMinutes} min';
    if (diff.inHours < 24) return '${diff.inHours} h';
    return '${diff.inDays} d';
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final colors = context.statusColors;

    return ListTile(
      key: Key('notification-${notification.id}'),
      leading: Container(
        width: 10,
        height: 10,
        margin: const EdgeInsets.only(top: AlfaSpacing.md),
        decoration: BoxDecoration(
          color: notification.isUnread ? colors.info : Colors.transparent,
          shape: BoxShape.circle,
        ),
      ),
      title: Text(
        notification.title,
        style: theme.textTheme.bodyLarge?.copyWith(
          fontWeight: notification.isUnread ? FontWeight.w700 : FontWeight.w400,
        ),
      ),
      subtitle: Text(notification.body),
      trailing: Text(
        _ago(notification.createdAt),
        style: theme.textTheme.bodySmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
      onTap: () {
        final controller = ref.read(notificationsControllerProvider.notifier);
        if (notification.isUnread) {
          controller.markRead(ids: [notification.id]);
        }
        /*
          O deep link abre a tela — a AUTORIZAÇÃO é da API.

          `resourceId` veio de uma notificação, e notificação não é prova de
          acesso. A tela de detalhe consulta o servidor normalmente; se a OS
          tiver sido reatribuída, ela responde 404 e o app mostra "não está mais
          atribuída a você" em vez de exibir dado que já não é dele.
        */
        if (notification.pointsToServiceOrder) {
          context.push('/orders/${notification.resourceId}');
        }
      },
    );
  }
}
