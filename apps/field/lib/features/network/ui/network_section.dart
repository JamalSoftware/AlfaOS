import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/widgets/state_views.dart';
import '../../orders/domain/service_order.dart';
import '../domain/network.dart';
import '../state/network_controller.dart';
import 'network_picker.dart';

/// A rede de distribuição dentro da ordem de serviço.
///
/// ## Por que ela vive AQUI, e não numa aba própria
///
/// O técnico não navega pela rede da empresa: ele atende um cliente. A
/// operação de porta existe porque há uma visita acontecendo, e tirá-la da OS
/// criaria uma superfície em que a pergunta *para qual cliente?* voltaria a
/// precisar de resposta — que é exatamente o que o contrato da `CTO-2.4`
/// eliminou ao derivar o cliente da própria OS.
///
/// ## O portão de status é de UX, não de segurança
///
/// Fora de `IN_PROGRESS` a seção nem lê: a leitura também exige atendimento em
/// andamento, e chamar assim mesmo produziria um `409` garantido a cada
/// abertura de OS. Quem recusa de verdade continua sendo o servidor.
class NetworkSection extends ConsumerStatefulWidget {
  const NetworkSection({super.key, required this.order});

  final OrderDetail order;

  @override
  ConsumerState<NetworkSection> createState() => _NetworkSectionState();
}

class _NetworkSectionState extends ConsumerState<NetworkSection> {
  bool get _emAtendimento => widget.order.status == OrderStatus.inProgress;

  @override
  void initState() {
    super.initState();
    if (_emAtendimento) _agendarCarga();
  }

  @override
  void didUpdateWidget(NetworkSection old) {
    super.didUpdateWidget(old);
    // Iniciar o atendimento é o que abre a seção. Sem isto ela ficaria vazia
    // até o técnico sair e voltar da tela.
    if (old.order.status != OrderStatus.inProgress && _emAtendimento) {
      _agendarCarga();
    }
  }

  void _agendarCarga() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final provider = networkControllerProvider(widget.order.id);
      final state = ref.read(provider);
      if (state.loaded || state.loading) return;
      ref.read(provider.notifier).load();
    });
  }

  void _toast(String mensagem) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(mensagem)));
  }

  @override
  Widget build(BuildContext context) {
    final provider = networkControllerProvider(widget.order.id);
    final state = ref.watch(provider);

    // Confirmação específica de CADA operação. `hideCurrentSnackBar` antes de
    // mostrar impede que a mensagem da ação anterior seja lida como resultado
    // desta.
    ref.listen(provider, (previous, next) {
      final mensagem = next.actionMessage;
      if (mensagem != null && mensagem != previous?.actionMessage) {
        _toast(mensagem);
        ref.read(provider.notifier).consumeMessage();
      }
    });

    return SectionCard(
      title: 'Rede · CTO',
      child: _conteudo(context, state, provider),
    );
  }

  Widget _conteudo(
    BuildContext context,
    NetworkState state,
    AutoDisposeStateNotifierProvider<NetworkController, NetworkState> provider,
  ) {
    final theme = Theme.of(context);

    if (!_emAtendimento) {
      return Text(
        'A porta da CTO pode ser alterada durante o atendimento.',
        key: const Key('network-locked'),
        style: theme.textTheme.bodyMedium?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      );
    }

    if (state.loading && !state.loaded) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: AlfaSpacing.md),
        child: Center(
          child: SizedBox(
            height: 24,
            width: 24,
            child: CircularProgressIndicator(
              strokeWidth: 2,
              semanticsLabel: 'Carregando a rede',
            ),
          ),
        ),
      );
    }

    if (state.error != null && !state.loaded) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(state.error!, style: theme.textTheme.bodyMedium),
          const SizedBox(height: AlfaSpacing.md),
          OutlinedButton(
            key: const Key('network-retry'),
            onPressed: () => ref.read(provider.notifier).load(),
            child: const Text('Tentar novamente'),
          ),
        ],
      );
    }

    final connection = state.connection;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (connection == null)
          _semVinculo(context, state)
        else
          _comVinculo(context, state, connection),
        if (state.actionError != null) ...[
          const SizedBox(height: AlfaSpacing.md),
          /*
            A recusa fica ao lado dos botões que a provocaram.

            É a `CTO-1.3` e a `CTO-2.3.2` na mesma família: uma mensagem
            renderizada longe do gesto mede `viewport ratio 0` e é
            indistinguível de um botão quebrado.
          */
          _Alerta(
            key: const Key('network-action-error'),
            message: state.actionError!,
          ),
        ],
      ],
    );
  }

  Widget _semVinculo(BuildContext context, NetworkState state) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Icon(
              Icons.link_off,
              size: 20,
              color: theme.colorScheme.onSurfaceVariant,
            ),
            const SizedBox(width: AlfaSpacing.sm),
            Expanded(
              child: Text(
                'Cliente sem vínculo de CTO.',
                key: const Key('network-empty'),
                style: theme.textTheme.bodyMedium,
              ),
            ),
          ],
        ),
        const SizedBox(height: AlfaSpacing.md),
        FilledButton.icon(
          key: const Key('network-connect'),
          onPressed: state.submitting ? null : () => _abrirPicker(null),
          icon: const Icon(Icons.add_link),
          label: const Text('Vincular à CTO'),
        ),
      ],
    );
  }

  Widget _comVinculo(
    BuildContext context,
    NetworkState state,
    NetworkPlacement connection,
  ) {
    final theme = Theme.of(context);
    final port = connection.port;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          connection.cto.name,
          key: const Key('network-cto-name'),
          style: theme.textTheme.titleSmall,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
        ),
        if (connection.cto.code != null && connection.cto.code!.isNotEmpty)
          Text(
            connection.cto.code!,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        const SizedBox(height: AlfaSpacing.sm),
        Text(
          'Porta ${port.label}',
          key: const Key('network-port'),
          style: theme.textTheme.headlineSmall,
        ),
        if (connection.connectedAt != null)
          Text(
            'Conectado desde ${_data(connection.connectedAt!)}',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        const SizedBox(height: AlfaSpacing.md),
        /*
          As DUAS dimensões, sempre.

          `administrativeState` e `occupied` são independentes: uma porta pode
          estar danificada COM cliente dentro, e esconder o estado
          administrativo apagaria justamente a informação que fez alguém
          marcá-la. Colapsar em um rótulo só é o defeito que a `CTO-2.2`
          corrigiu no resumo administrativo.
        */
        Wrap(
          spacing: AlfaSpacing.sm,
          runSpacing: AlfaSpacing.sm,
          children: [
            if (port.occupied)
              const _Selo(
                key: Key('network-badge-occupied'),
                texto: 'Ocupada',
                tom: _Tom.info,
              ),
            if (port.administrativeState.deservesBadge)
              _Selo(
                key: const Key('network-badge-admin'),
                texto: port.administrativeState.label,
                tom: port.administrativeState == PortAdministrativeState.damaged
                    ? _Tom.perigo
                    : _Tom.atencao,
              ),
            if (!connection.cto.active)
              const _Selo(
                key: Key('network-badge-inactive'),
                texto: 'CTO inativa',
                tom: _Tom.atencao,
              ),
          ],
        ),
        const SizedBox(height: AlfaSpacing.md),
        // `Wrap`, e não `Row`: em 320dp com escala de texto grande, dois botões
        // lado a lado estouram — e a lição já custou dois overflows na DQ-6.
        Wrap(
          spacing: AlfaSpacing.sm,
          runSpacing: AlfaSpacing.sm,
          children: [
            OutlinedButton.icon(
              key: const Key('network-move'),
              onPressed: state.submitting
                  ? null
                  : () => _abrirPicker(connection),
              icon: const Icon(Icons.swap_horiz),
              label: const Text('Mover'),
            ),
            OutlinedButton.icon(
              key: const Key('network-disconnect'),
              onPressed: state.submitting
                  ? null
                  : () => _confirmarDesconexao(connection),
              icon: const Icon(Icons.link_off),
              label: const Text('Desconectar'),
            ),
          ],
        ),
      ],
    );
  }

  void _abrirPicker(NetworkPlacement? origem) {
    showNetworkPicker(
      context,
      orderId: widget.order.id,
      expectedVersion: widget.order.version,
      origin: origem,
    );
  }

  Future<void> _confirmarDesconexao(NetworkPlacement connection) async {
    final aceito = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Desconectar da CTO?'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(connection.cto.name),
            Text('Porta ${connection.port.label}'),
            const SizedBox(height: AlfaSpacing.md),
            const Text(
              'O histórico será preservado: o registro continua mostrando que '
              'o cliente esteve nesta porta.',
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancelar'),
          ),
          FilledButton(
            key: const Key('network-disconnect-confirm'),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Desconectar'),
          ),
        ],
      ),
    );

    if (aceito != true || !mounted) return;
    await ref
        .read(networkControllerProvider(widget.order.id).notifier)
        .disconnect(
          expectedVersion: widget.order.version,
          // O vínculo que a TELA está mostrando, nunca "o atual do cliente":
          // sem isso, uma tela velha encerraria um vínculo que ninguém viu.
          expectedConnectionId: connection.connectionId,
          portLabel: connection.port.label,
        );
  }

  String _data(DateTime valor) {
    String dois(int n) => n.toString().padLeft(2, '0');
    return '${dois(valor.day)}/${dois(valor.month)}/${valor.year} '
        '${dois(valor.hour)}:${dois(valor.minute)}';
  }
}

enum _Tom { info, atencao, perigo }

class _Selo extends StatelessWidget {
  const _Selo({super.key, required this.texto, required this.tom});

  final String texto;
  final _Tom tom;

  @override
  Widget build(BuildContext context) {
    final colors = context.statusColors;
    final (fg, bg) = switch (tom) {
      _Tom.info => (colors.info, colors.infoContainer),
      _Tom.atencao => (colors.warning, colors.warningContainer),
      _Tom.perigo => (colors.danger, colors.dangerContainer),
    };
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AlfaSpacing.md,
        vertical: AlfaSpacing.xs,
      ),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(AlfaRadius.pill),
      ),
      child: Text(
        texto,
        style: Theme.of(context).textTheme.labelMedium?.copyWith(color: fg),
      ),
    );
  }
}

class _Alerta extends StatelessWidget {
  const _Alerta({super.key, required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.all(AlfaSpacing.md),
      decoration: BoxDecoration(
        color: theme.colorScheme.errorContainer,
        borderRadius: BorderRadius.circular(AlfaRadius.md),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            Icons.error_outline,
            size: 20,
            color: theme.colorScheme.onErrorContainer,
          ),
          const SizedBox(width: AlfaSpacing.sm),
          Expanded(
            child: Text(
              message,
              style: TextStyle(color: theme.colorScheme.onErrorContainer),
            ),
          ),
        ],
      ),
    );
  }
}
