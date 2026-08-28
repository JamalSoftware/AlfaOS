import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/launchers/external_links.dart';
import '../../../core/widgets/state_views.dart';
import '../../../core/widgets/status_pill.dart';
import '../domain/service_order.dart';
import '../state/order_detail_controller.dart';

/// Detalhe operacional da OS.
///
/// A hierarquia é a do técnico na rua, não a do painel administrativo: número e
/// estado, **a ação**, com quem falar, como chegar, o acesso, o diagnóstico e
/// só então a descrição do serviço. Quem está de pé, no sol, com uma mão,
/// precisa da ação antes do cadastro.
class OrderDetailScreen extends ConsumerStatefulWidget {
  const OrderDetailScreen({super.key, required this.orderId});

  final String orderId;

  @override
  ConsumerState<OrderDetailScreen> createState() => _OrderDetailScreenState();
}

class _OrderDetailScreenState extends ConsumerState<OrderDetailScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(orderDetailControllerProvider(widget.orderId).notifier).load();
    });
  }

  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final provider = orderDetailControllerProvider(widget.orderId);
    final state = ref.watch(provider);

    ref.listen(provider, (previous, next) {
      final message = next.actionMessage;
      if (message != null && message != previous?.actionMessage) {
        _toast(message);
        ref.read(provider.notifier).consumeMessage();
      }
    });

    return Scaffold(
      appBar: AppBar(
        title: Text(
          state.order == null
              ? 'Ordem de serviço'
              : 'OS Nº ${state.order!.number}',
        ),
      ),
      body: _body(state),
    );
  }

  Widget _body(OrderDetailState state) {
    if (state.loading && state.order == null) {
      return const Center(child: CircularProgressIndicator());
    }

    /*
      A OS não é mais dele.

      Acontece de verdade: o despachante reatribui enquanto o técnico está a
      caminho, ou a notificação aponta para algo que mudou de dono. Não é falha
      do aplicativo nem erro de rede — é uma decisão da operação, e a tela diz
      isso em vez de mostrar "não foi possível carregar".
    */
    if (state.notFound) {
      return const EmptyView(
        title: 'Esta ordem não está mais atribuída a você.',
        description: 'Volte para a lista e puxe para atualizar.',
        icon: Icons.assignment_late_outlined,
      );
    }

    if (state.error != null && state.order == null) {
      return ErrorView(
        message: 'Não foi possível carregar a ordem.',
        onRetry: () => ref
            .read(orderDetailControllerProvider(widget.orderId).notifier)
            .load(),
      );
    }

    final order = state.order;
    if (order == null) return const SizedBox.shrink();

    return RefreshIndicator(
      onRefresh: () => ref
          .read(orderDetailControllerProvider(widget.orderId).notifier)
          .load(),
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(AlfaSpacing.lg),
        children: [
          _Header(order: order),
          const SizedBox(height: AlfaSpacing.lg),
          _MainAction(orderId: widget.orderId, state: state),
          const SizedBox(height: AlfaSpacing.lg),
          _CustomerSection(customer: order.customer, onToast: _toast),
          const SizedBox(height: AlfaSpacing.md),
          _AddressSection(customer: order.customer, onToast: _toast),
          const SizedBox(height: AlfaSpacing.md),
          _ConnectionSection(
            orderId: widget.orderId,
            state: state,
            onToast: _toast,
          ),
          const SizedBox(height: AlfaSpacing.md),
          _DiagnosticSection(orderId: widget.orderId, state: state),
          const SizedBox(height: AlfaSpacing.md),
          _ServiceSection(order: order),
          const SizedBox(height: AlfaSpacing.xxl),
        ],
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.order});

  final OrderDetail order;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'OS Nº ${order.number}',
          style: theme.textTheme.headlineSmall?.copyWith(
            fontWeight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: AlfaSpacing.sm),
        Wrap(
          spacing: AlfaSpacing.sm,
          runSpacing: AlfaSpacing.xs,
          children: [
            StatusPill(status: order.status),
            PriorityBadge(priority: order.priority),
          ],
        ),
      ],
    );
  }
}

/// A ação principal, logo abaixo do cabeçalho.
///
/// **Não existe botão de concluir nesta Alpha.** A conclusão depende de
/// checklist, fotos, materiais e assinatura, e a validação é do servidor —
/// oferecer um "concluir" incompleto produziria OS fechadas sem evidência.
class _MainAction extends ConsumerWidget {
  const _MainAction({required this.orderId, required this.state});

  final String orderId;
  final OrderDetailState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final order = state.order!;
    final colors = context.statusColors;

    if (order.isInProgress) {
      return Container(
        key: const Key('order-in-progress'),
        padding: const EdgeInsets.all(AlfaSpacing.lg),
        decoration: BoxDecoration(
          color: colors.infoContainer,
          borderRadius: BorderRadius.circular(AlfaRadius.md),
        ),
        child: Row(
          children: [
            Icon(Icons.play_circle_outline, color: colors.info),
            const SizedBox(width: AlfaSpacing.md),
            Expanded(
              child: Text(
                'ATENDIMENTO EM ANDAMENTO',
                style: TextStyle(
                  color: colors.info,
                  fontWeight: FontWeight.w700,
                  fontSize: 14,
                ),
              ),
            ),
          ],
        ),
      );
    }

    if (!order.canStart) return const SizedBox.shrink();

    return FilledButton.icon(
      key: const Key('order-start'),
      // Desabilitado enquanto envia: é o que impede o duplo toque de virar
      // duas requisições. A chave de idempotência cobre o resto.
      onPressed: state.starting
          ? null
          : () => ref
                .read(orderDetailControllerProvider(orderId).notifier)
                .start(),
      icon: state.starting
          ? const SizedBox(
              height: 18,
              width: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : const Icon(Icons.play_arrow_rounded),
      label: Text(state.starting ? 'INICIANDO...' : 'INICIAR ATENDIMENTO'),
    );
  }
}

class _CustomerSection extends StatelessWidget {
  const _CustomerSection({required this.customer, required this.onToast});

  final OrderCustomer customer;
  final void Function(String) onToast;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final phones = customer.phones;

    return SectionCard(
      title: 'Cliente',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            customer.name,
            style: theme.textTheme.titleMedium?.copyWith(
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: AlfaSpacing.md),
          if (phones.isEmpty)
            Text(
              'Telefone não informado.',
              key: const Key('customer-no-phone'),
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            )
          else
            /*
              Os DOIS telefones, cada um com seu botão.

              Telefone que não atende é o motivo nº 1 de uma visita perdida, e o
              segundo contato já existia no cadastro sem chegar a quem vai a
              campo. Um chip por número deixa a segunda tentativa a um toque.
            */
            Wrap(
              spacing: AlfaSpacing.sm,
              runSpacing: AlfaSpacing.sm,
              children: [
                for (var i = 0; i < phones.length; i++)
                  _PhoneChip(
                    key: Key('customer-phone-$i'),
                    phone: phones[i],
                    onToast: onToast,
                  ),
              ],
            ),
        ],
      ),
    );
  }
}

class _PhoneChip extends StatelessWidget {
  const _PhoneChip({super.key, required this.phone, required this.onToast});

  final String phone;
  final void Function(String) onToast;

  @override
  Widget build(BuildContext context) {
    return ActionChip(
      avatar: const Icon(Icons.call_outlined, size: 18),
      label: Text(phone),
      onPressed: () async {
        final ok = await ExternalLinks.dial(phone);
        if (!ok) onToast('Não foi possível abrir o discador.');
      },
    );
  }
}

class _AddressSection extends StatelessWidget {
  const _AddressSection({required this.customer, required this.onToast});

  final OrderCustomer customer;
  final void Function(String) onToast;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final address = customer.formattedAddress;
    final hasCoordinates = customer.hasUsableCoordinates;
    final canNavigate = hasCoordinates || (address != null);

    return SectionCard(
      title: 'Endereço',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            address ?? 'Endereço não informado.',
            style: theme.textTheme.bodyLarge,
          ),
          if (canNavigate) ...[
            const SizedBox(height: AlfaSpacing.lg),
            /*
              A coordenada NUNCA aparece como texto.

              Latitude e longitude cruas não ajudam ninguém a chegar num lugar e
              ocupam a linha onde deveria estar o endereço. Elas existem só
              dentro do destino da navegação.
            */
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    key: const Key('open-maps'),
                    onPressed: () => _open(_Target.maps),
                    icon: const Icon(Icons.map_outlined, size: 18),
                    label: const Text('Maps'),
                  ),
                ),
                const SizedBox(width: AlfaSpacing.md),
                Expanded(
                  child: OutlinedButton.icon(
                    key: const Key('open-waze'),
                    onPressed: () => _open(_Target.waze),
                    icon: const Icon(Icons.navigation_outlined, size: 18),
                    label: const Text('Waze'),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  /// Coordenada quando existe; endereço como alternativa.
  ///
  /// Coordenada leva ao ponto; endereço leva ao número da rua, que às vezes é o
  /// que existe. O aplicativo **não** geocodifica por conta própria — quem faz
  /// isso melhor é o app de mapas.
  Future<void> _open(_Target target) async {
    var ok = false;
    if (customer.hasUsableCoordinates) {
      final lat = customer.latitude!;
      final lng = customer.longitude!;
      ok = target == _Target.maps
          ? await ExternalLinks.googleMapsByCoordinates(lat, lng)
          : await ExternalLinks.wazeByCoordinates(lat, lng);
    } else {
      final address = customer.formattedAddress;
      if (address != null) {
        ok = target == _Target.maps
            ? await ExternalLinks.googleMapsByAddress(address)
            : await ExternalLinks.wazeByAddress(address);
      }
    }
    if (!ok) {
      onToast(
        target == _Target.maps
            ? 'Não foi possível abrir o Google Maps.'
            : 'Não foi possível abrir o Waze.',
      );
    }
  }
}

enum _Target { maps, waze }

/// Acesso PPPoE do cliente.
///
/// A tela nasce com **máscara de comprimento fixo** — `••••`, sempre quatro.
/// Uma máscara do tamanho real vazaria o comprimento da senha, que é
/// informação de graça para quem tenta adivinhá-la.
class _ConnectionSection extends ConsumerWidget {
  const _ConnectionSection({
    required this.orderId,
    required this.state,
    required this.onToast,
  });

  final String orderId;
  final OrderDetailState state;
  final void Function(String) onToast;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final connection = state.order!.connection;

    if (connection == null) {
      return SectionCard(
        title: 'Acesso do cliente',
        child: Text(
          'Acesso PPPoE não configurado.',
          key: const Key('pppoe-absent'),
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      );
    }

    final revealed = state.revealedPassword;
    final controller = ref.read(
      orderDetailControllerProvider(orderId).notifier,
    );

    return SectionCard(
      title: 'Acesso do cliente',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          /*
            O usuário tem cópia própria, e a senha tem a dela.

            Antes, copiar só existia depois de revelar a senha — e o técnico que
            precisava apenas do login para conferir no roteador era obrigado a
            expor o segredo na tela para chegar ao botão. Duas ações separadas
            eliminam essa revelação desnecessária.

            O usuário PPPoE não é segredo: ele já vem no detalhe da OS, sem
            revelação, sem auditoria e sem teto de frequência. Copiá-lo não
            precisa de nenhuma dessas proteções.
          */
          _Field(
            label: 'Usuário',
            value: connection.username,
            trailing: IconButton(
              key: const Key('pppoe-copy-username'),
              tooltip: 'Copiar usuário',
              onPressed: () async {
                await Clipboard.setData(
                  ClipboardData(text: connection.username),
                );
                onToast('Usuário copiado.');
              },
              icon: const Icon(Icons.copy_outlined, size: 18),
            ),
          ),
          const SizedBox(height: AlfaSpacing.md),
          if (!connection.passwordConfigured)
            Text(
              'Senha não configurada.',
              key: const Key('pppoe-no-password'),
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            )
          else ...[
            _Field(
              label: 'Senha',
              value: revealed ?? '••••',
              valueKey: const Key('pppoe-password-value'),
              monospace: true,
            ),
            const SizedBox(height: AlfaSpacing.md),
            Wrap(
              spacing: AlfaSpacing.sm,
              runSpacing: AlfaSpacing.sm,
              children: [
                if (revealed == null)
                  OutlinedButton.icon(
                    key: const Key('pppoe-reveal'),
                    onPressed: state.revealing
                        ? null
                        : () => controller.revealPassword(),
                    icon: state.revealing
                        ? const SizedBox(
                            height: 16,
                            width: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.visibility_outlined, size: 18),
                    label: const Text('MOSTRAR SENHA'),
                  )
                else ...[
                  OutlinedButton.icon(
                    key: const Key('pppoe-hide'),
                    // Ocultar DESCARTA o texto claro da memória, não apenas
                    // esconde: voltar à máscara sem apagar deixaria o segredo
                    // vivo num aparelho que pode ser roubado a seguir.
                    onPressed: controller.hidePassword,
                    icon: const Icon(Icons.visibility_off_outlined, size: 18),
                    label: const Text('OCULTAR'),
                  ),
                  OutlinedButton.icon(
                    key: const Key('pppoe-copy'),
                    // "COPIAR SENHA", não "COPIAR": agora existem duas ações de
                    // cópia nesta seção, e um rótulo genérico deixaria o técnico
                    // adivinhando qual das duas ele acabou de tocar.
                    onPressed: () async {
                      await Clipboard.setData(ClipboardData(text: revealed));
                      onToast('Senha copiada.');
                    },
                    icon: const Icon(Icons.copy_outlined, size: 18),
                    label: const Text('COPIAR SENHA'),
                  ),
                ],
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _DiagnosticSection extends ConsumerWidget {
  const _DiagnosticSection({required this.orderId, required this.state});

  final String orderId;
  final OrderDetailState state;

  static String _ago(DateTime when) {
    final diff = DateTime.now().difference(when);
    if (diff.inMinutes < 1) return 'agora';
    if (diff.inMinutes < 60) return 'há ${diff.inMinutes} min';
    if (diff.inHours < 24) return 'há ${diff.inHours} h';
    return 'há ${diff.inDays} d';
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final colors = context.statusColors;
    final diagnostic = state.order!.diagnostic;

    final dotColor = diagnostic == null
        ? colors.neutral
        : diagnostic.isOnline
        ? colors.success
        : diagnostic.isOffline
        ? colors.danger
        : colors.neutral;

    return SectionCard(
      title: 'Diagnóstico',
      trailing: TextButton(
        key: const Key('diagnostic-refresh'),
        onPressed: state.refreshingDiagnostic
            ? null
            : () => ref
                  .read(orderDetailControllerProvider(orderId).notifier)
                  .refreshDiagnostic(),
        child: Text(state.refreshingDiagnostic ? '...' : 'ATUALIZAR'),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 10,
                height: 10,
                decoration: BoxDecoration(
                  color: dotColor,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: AlfaSpacing.sm),
              Text(
                diagnostic?.label ?? 'Sem leitura',
                key: const Key('diagnostic-status'),
                style: theme.textTheme.bodyLarge?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
              ),
              if (diagnostic?.observedAt != null) ...[
                const SizedBox(width: AlfaSpacing.sm),
                Text(
                  _ago(diagnostic!.observedAt!),
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ],
          ),
          /*
            Falha de leitura NÃO vira OFFLINE.

            "Não conseguimos falar com o provedor" e "o provedor diz que o
            cliente está fora" são fatos diferentes. Colapsar o primeiro no
            segundo mandaria o técnico procurar defeito onde não há — por causa
            de uma integração instável. O último estado válido continua na tela,
            com um aviso de que é velho.
          */
          if (state.diagnosticWarning != null) ...[
            const SizedBox(height: AlfaSpacing.md),
            Text(
              state.diagnosticWarning!,
              key: const Key('diagnostic-warning'),
              style: theme.textTheme.bodySmall?.copyWith(color: colors.warning),
            ),
          ],
        ],
      ),
    );
  }
}

class _ServiceSection extends StatelessWidget {
  const _ServiceSection({required this.order});

  final OrderDetail order;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SectionCard(
      title: 'Serviço',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            order.subtype == null || order.subtype!.isEmpty
                ? order.type
                : '${order.type} · ${order.subtype}',
            style: theme.textTheme.titleSmall?.copyWith(
              fontWeight: FontWeight.w600,
            ),
          ),
          if (order.description.isNotEmpty) ...[
            const SizedBox(height: AlfaSpacing.sm),
            Text(order.description, style: theme.textTheme.bodyMedium),
          ],
        ],
      ),
    );
  }
}

class _Field extends StatelessWidget {
  const _Field({
    required this.label,
    required this.value,
    this.valueKey,
    this.monospace = false,
    this.trailing,
  });

  final String label;
  final String value;
  final Key? valueKey;
  final bool monospace;

  /// Ação à direita do valor — hoje, o botão de copiar o usuário.
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final campo = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 2),
        SelectableText(
          value,
          key: valueKey,
          style: theme.textTheme.bodyLarge?.copyWith(
            fontFamily: monospace ? 'monospace' : null,
            fontWeight: FontWeight.w600,
          ),
        ),
      ],
    );

    if (trailing == null) return campo;

    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        // `Expanded` para que um usuário PPPoE longo quebre em vez de empurrar
        // o botão para fora da tela num aparelho estreito.
        Expanded(child: campo),
        const SizedBox(width: AlfaSpacing.sm),
        trailing!,
      ],
    );
  }
}
