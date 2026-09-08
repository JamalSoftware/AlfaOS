import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/errors/field_error.dart';
import '../data/network_repository.dart';
import '../domain/network.dart';
import '../state/network_controller.dart';

/// Escolha de caixa e porta, em uma folha só.
///
/// Três passos — caixa, porta, confirmação — dentro do mesmo modal, e não três
/// telas empilhadas: o técnico está de pé, com uma mão, e voltar um passo não
/// pode significar perder o contexto da OS.
///
/// A folha **executa** a mutação e fecha no sucesso, como o resto da execução
/// em campo já faz. Devolver o destino para o chamador espalharia o tratamento
/// de conflito por dois lugares, e é justamente o conflito que precisa de uma
/// resposta só.
Future<void> showNetworkPicker(
  BuildContext context, {
  required String orderId,
  required int expectedVersion,
  required NetworkPlacement? origin,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (context) => _NetworkPickerSheet(
      orderId: orderId,
      expectedVersion: expectedVersion,
      origin: origin,
    ),
  );
}

enum _Step { cto, port, confirm }

class _NetworkPickerSheet extends ConsumerStatefulWidget {
  const _NetworkPickerSheet({
    required this.orderId,
    required this.expectedVersion,
    required this.origin,
  });

  final String orderId;
  final int expectedVersion;

  /// Onde o cliente está hoje. `null` = vincular; preenchido = mover.
  final NetworkPlacement? origin;

  @override
  ConsumerState<_NetworkPickerSheet> createState() =>
      _NetworkPickerSheetState();
}

class _NetworkPickerSheetState extends ConsumerState<_NetworkPickerSheet> {
  final _search = TextEditingController();
  Timer? _debounce;

  _Step _step = _Step.cto;
  bool _loading = true;
  bool _submitting = false;
  String? _error;

  List<CandidateCto> _ctos = const [];
  CandidateCtoDetail? _cto;
  NetworkPort? _port;

  bool get _moving => widget.origin != null;

  NetworkRepository get _repo => ref.read(networkRepositoryProvider);

  @override
  void initState() {
    super.initState();
    _loadCtos();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    super.dispose();
  }

  Future<void> _loadCtos() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final ctos = await _repo.candidates(
        widget.orderId,
        search: _search.text.trim(),
      );
      if (!mounted) return;
      setState(() {
        _ctos = ctos;
        _loading = false;
      });
    } on FieldException catch (error) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = error.message;
      });
    }
  }

  void _onSearchChanged(String _) {
    // Debounce porque a rede do técnico é a pior do sistema: uma requisição por
    // tecla gastaria a conexão que a operação inteira depende.
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), _loadCtos);
  }

  Future<void> _openCto(CandidateCto candidate) async {
    setState(() {
      _step = _Step.port;
      _loading = true;
      _error = null;
      _cto = null;
      _port = null;
    });
    try {
      final detail = await _repo.cto(widget.orderId, candidate.id);
      if (!mounted) return;
      setState(() {
        _cto = detail;
        _loading = false;
      });
    } on FieldException catch (error) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = error.message;
      });
    }
  }

  Future<void> _submit() async {
    final cto = _cto;
    final port = _port;
    if (cto == null || port == null || _submitting) return;

    setState(() {
      _submitting = true;
      _error = null;
    });

    final controller = ref.read(
      networkControllerProvider(widget.orderId).notifier,
    );
    final origin = widget.origin;
    final ok = origin == null
        ? await controller.connect(
            expectedVersion: widget.expectedVersion,
            ctoPortId: port.id,
            ctoName: cto.name,
            portLabel: port.label,
          )
        : await controller.move(
            expectedVersion: widget.expectedVersion,
            expectedConnectionId: origin.connectionId,
            targetCtoPortId: port.id,
            ctoName: cto.name,
            portLabel: port.label,
          );

    if (!mounted) return;
    if (ok) {
      Navigator.of(context).pop();
      return;
    }
    /*
      A recusa fecha a folha e a mensagem sobe para a SEÇÃO.

      É a lição da `CTO-2.3`: um conflito relê o estado, a premissa da folha
      deixa de existir — a porta foi ocupada, o vínculo mudou — e uma mensagem
      presa aqui dentro sumiria junto com ela. Recusa invisível é
      indistinguível de botão quebrado.
    */
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: EdgeInsets.only(
        left: AlfaSpacing.lg,
        right: AlfaSpacing.lg,
        top: AlfaSpacing.lg,
        bottom: MediaQuery.of(context).viewInsets.bottom + AlfaSpacing.lg,
      ),
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.7,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _header(theme),
            const SizedBox(height: AlfaSpacing.md),
            Expanded(child: _body(theme)),
          ],
        ),
      ),
    );
  }

  Widget _header(ThemeData theme) {
    final titulo = switch (_step) {
      _Step.cto => _moving ? 'Mover para qual CTO?' : 'Escolha a CTO',
      _Step.port => _cto?.name ?? 'Escolha a porta',
      _Step.confirm => 'Confirmar',
    };
    return Row(
      children: [
        if (_step != _Step.cto)
          IconButton(
            key: const Key('network-picker-back'),
            icon: const Icon(Icons.arrow_back),
            tooltip: 'Voltar',
            onPressed: _submitting
                ? null
                : () => setState(() {
                    _step = _step == _Step.confirm ? _Step.port : _Step.cto;
                    _error = null;
                  }),
          ),
        Expanded(
          child: Text(
            titulo,
            style: theme.textTheme.titleMedium,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
        ),
        IconButton(
          icon: const Icon(Icons.close),
          tooltip: 'Fechar',
          onPressed: _submitting ? null : () => Navigator.of(context).pop(),
        ),
      ],
    );
  }

  Widget _body(ThemeData theme) {
    if (_loading) {
      return const Center(
        child: CircularProgressIndicator(semanticsLabel: 'Carregando'),
      );
    }
    if (_error != null && _step != _Step.confirm) {
      return _ErrorBlock(message: _error!, onRetry: _retry);
    }
    return switch (_step) {
      _Step.cto => _ctoList(theme),
      _Step.port => _portList(theme),
      _Step.confirm => _confirm(theme),
    };
  }

  void _retry() {
    if (_step == _Step.cto) {
      _loadCtos();
      return;
    }
    final cto = _cto;
    if (cto != null) {
      _openCto(
        CandidateCto(
          id: cto.id,
          name: cto.name,
          code: cto.code,
          active: cto.active,
          capacity: cto.capacity,
          availablePorts: cto.availablePorts,
        ),
      );
    } else {
      setState(() => _step = _Step.cto);
      _loadCtos();
    }
  }

  Widget _ctoList(ThemeData theme) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          key: const Key('network-cto-search'),
          controller: _search,
          onChanged: _onSearchChanged,
          textInputAction: TextInputAction.search,
          decoration: const InputDecoration(
            labelText: 'Buscar CTO',
            hintText: 'Nome ou código',
            prefixIcon: Icon(Icons.search),
          ),
        ),
        const SizedBox(height: AlfaSpacing.md),
        Expanded(
          child: _ctos.isEmpty
              ? _EmptyBlock(
                  key: const Key('network-cto-empty'),
                  message: _search.text.trim().isEmpty
                      ? 'Nenhuma CTO disponível.'
                      : 'Nenhuma CTO encontrada para esta busca.',
                  onRetry: _loadCtos,
                )
              : ListView.builder(
                  // `builder`, e não `Column`: uma empresa pode ter centenas de
                  // caixas, e construir todas de uma vez gasta memória num
                  // aparelho de campo por conteúdo que ninguém rolou até ver.
                  itemCount: _ctos.length,
                  itemBuilder: (context, index) {
                    final cto = _ctos[index];
                    final semPortas = cto.availablePorts == 0;
                    return ListTile(
                      key: Key('network-cto-${cto.id}'),
                      title: Text(
                        cto.name,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: Text(
                        [
                          if (cto.code != null && cto.code!.isNotEmpty)
                            cto.code!,
                          semPortas
                              ? 'Sem portas livres'
                              : '${cto.availablePorts} '
                                    '${cto.availablePorts == 1 ? "porta livre" : "portas livres"}',
                        ].join(' · '),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      trailing: const Icon(Icons.chevron_right),
                      enabled: !semPortas,
                      onTap: semPortas ? null : () => _openCto(cto),
                    );
                  },
                ),
        ),
      ],
    );
  }

  Widget _portList(ThemeData theme) {
    final cto = _cto;
    if (cto == null) return const SizedBox.shrink();

    /*
      Só o que o SERVIDOR marcou como ofertável.

      `availableForConnection` chega pronto e não é recalculado aqui:
      reimplementar `isPortOfferable` em Dart criaria uma segunda autoridade —
      e a porta que já está com este cliente sai da lista por consequência, sem
      precisar de regra própria, porque ela chega ocupada.
    */
    final livres = cto.offerable;
    if (livres.isEmpty) {
      return _EmptyBlock(
        key: const Key('network-port-empty'),
        message: 'Nenhuma porta disponível nesta CTO.',
        onRetry: _retry,
      );
    }

    return ListView.builder(
      // Uma caixa chega a 256 posições. `builder` constrói o que está na tela.
      itemCount: livres.length,
      itemBuilder: (context, index) {
        final port = livres[index];
        return ListTile(
          key: Key('network-port-${port.id}'),
          leading: const Icon(Icons.settings_input_hdmi_outlined),
          title: Text('Porta ${port.label}'),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => setState(() {
            _port = port;
            _step = _Step.confirm;
          }),
        );
      },
    );
  }

  Widget _confirm(ThemeData theme) {
    final cto = _cto!;
    final port = _port!;
    final origin = widget.origin;

    return ListView(
      children: [
        if (origin != null) ...[
          _Resumo(rotulo: 'De', cto: origin.cto.name, porta: origin.port.label),
          const SizedBox(height: AlfaSpacing.md),
          Icon(Icons.south, color: theme.colorScheme.onSurfaceVariant),
          const SizedBox(height: AlfaSpacing.md),
        ],
        _Resumo(
          rotulo: origin == null ? 'Vincular em' : 'Para',
          cto: cto.name,
          porta: port.label,
        ),
        const SizedBox(height: AlfaSpacing.lg),
        if (_error != null) ...[
          _InlineError(message: _error!),
          const SizedBox(height: AlfaSpacing.md),
        ],
        Row(
          children: [
            Expanded(
              child: OutlinedButton(
                onPressed: _submitting
                    ? null
                    : () => setState(() => _step = _Step.port),
                child: const Text('Cancelar'),
              ),
            ),
            const SizedBox(width: AlfaSpacing.md),
            Expanded(
              child: FilledButton(
                key: const Key('network-confirm'),
                // Travado durante o envio: um toque, um comando. A idempotência
                // do servidor continua sendo a proteção de verdade — isto é só
                // para o técnico não achar que nada aconteceu e tocar de novo.
                onPressed: _submitting ? null : _submit,
                child: _submitting
                    ? const SizedBox(
                        height: 20,
                        width: 20,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          semanticsLabel: 'Enviando',
                        ),
                      )
                    : Text(origin == null ? 'Vincular' : 'Mover'),
              ),
            ),
          ],
        ),
      ],
    );
  }
}

class _Resumo extends StatelessWidget {
  const _Resumo({required this.rotulo, required this.cto, required this.porta});

  final String rotulo;
  final String cto;
  final String porta;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.all(AlfaSpacing.md),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(AlfaRadius.md),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            rotulo.toUpperCase(),
            style: theme.textTheme.labelSmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
              letterSpacing: 0.8,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: AlfaSpacing.xs),
          Text(
            cto,
            style: theme.textTheme.titleSmall,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
          Text('Porta $porta', style: theme.textTheme.bodyMedium),
        ],
      ),
    );
  }
}

class _InlineError extends StatelessWidget {
  const _InlineError({required this.message});

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

class _ErrorBlock extends StatelessWidget {
  const _ErrorBlock({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          _InlineError(message: message),
          const SizedBox(height: AlfaSpacing.md),
          OutlinedButton(
            onPressed: onRetry,
            child: const Text('Tentar novamente'),
          ),
        ],
      ),
    );
  }
}

class _EmptyBlock extends StatelessWidget {
  const _EmptyBlock({super.key, required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.hub_outlined, size: 40, color: theme.colorScheme.outline),
          const SizedBox(height: AlfaSpacing.md),
          Text(
            message,
            textAlign: TextAlign.center,
            style: theme.textTheme.bodyMedium,
          ),
          const SizedBox(height: AlfaSpacing.md),
          OutlinedButton(onPressed: onRetry, child: const Text('Atualizar')),
        ],
      ),
    );
  }
}
