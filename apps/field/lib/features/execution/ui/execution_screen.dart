import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/sync/pending_operation.dart';
import '../../../core/widgets/state_views.dart';
import '../domain/execution.dart';
import '../state/execution_controller.dart';
import 'execution_forms.dart';

/// A tela de EXECUÇÃO do atendimento.
///
/// ## A ordem das seções é a ordem do trabalho
///
/// Localização e check-in primeiro, porque acontecem na chegada. Relatório,
/// checklist, fotos, materiais e equipamentos no meio, porque é o atendimento.
/// Assinatura e conclusão no fim, porque fecham. Uma tela organizada por
/// entidade de banco — todas as listas juntas, todos os formulários juntos —
/// obrigaria o técnico a subir e descer procurando a próxima coisa a fazer.
///
/// ## O botão de concluir não mente
///
/// Ele só habilita quando o SERVIDOR diz que não há pendência. Quando há, a
/// tela lista o que falta com o texto que o servidor mandou — e a lista da
/// última tentativa vale mais que a leitura da tela, porque foi resposta a um
/// comando real.
class ExecutionScreen extends ConsumerStatefulWidget {
  const ExecutionScreen({super.key, required this.orderId});

  final String orderId;

  @override
  ConsumerState<ExecutionScreen> createState() => _ExecutionScreenState();
}

class _ExecutionScreenState extends ConsumerState<ExecutionScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final notifier = ref.read(
        executionControllerProvider(widget.orderId).notifier,
      );
      notifier.load();
      notifier.loadStock();
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
    final provider = executionControllerProvider(widget.orderId);
    final state = ref.watch(provider);
    final notifier = ref.read(provider.notifier);

    ref.listen(provider, (previous, next) {
      if (next.message != null && next.message != previous?.message) {
        _toast(next.message!);
        notifier.consumeMessage();
      }
      if (next.locationMessage != null &&
          next.locationMessage != previous?.locationMessage) {
        _toast(next.locationMessage!);
        notifier.consumeLocationMessage();
      }
      // Concluiu: a tela de execução não faz mais sentido.
      if (next.completed && !(previous?.completed ?? false)) {
        Navigator.of(context).maybePop(true);
      }
    });

    return Scaffold(
      appBar: AppBar(title: const Text('Execução')),
      body: _body(state, notifier),
    );
  }

  Widget _body(ExecutionState state, ExecutionController notifier) {
    if (state.loading && state.bundle == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (state.notFound) {
      return const EmptyView(
        icon: Icons.search_off,
        title: 'Atendimento não encontrado',
        description: 'Esta OS não está mais atribuída a você.',
      );
    }
    final bundle = state.bundle;
    if (bundle == null) {
      return ErrorView(
        message: state.error ?? 'Não foi possível carregar o atendimento.',
        onRetry: notifier.load,
      );
    }

    return RefreshIndicator(
      onRefresh: notifier.load,
      child: ListView(
        padding: const EdgeInsets.all(AlfaSpacing.lg),
        children: [
          if (state.error != null) ...[
            _ErrorBanner(
              message: state.error!,
              onDismiss: notifier.consumeError,
            ),
            const SizedBox(height: AlfaSpacing.lg),
          ],
          _ProgressCard(bundle: bundle),
          const SizedBox(height: AlfaSpacing.lg),
          _LocationSection(state: state, notifier: notifier),
          const SizedBox(height: AlfaSpacing.lg),
          _CheckInSection(state: state, notifier: notifier),
          const SizedBox(height: AlfaSpacing.lg),
          _ReportSection(state: state, notifier: notifier),
          const SizedBox(height: AlfaSpacing.lg),
          if (bundle.checklist.isNotEmpty) ...[
            _ChecklistSection(state: state, notifier: notifier),
            const SizedBox(height: AlfaSpacing.lg),
          ],
          _PhotosSection(state: state, notifier: notifier),
          const SizedBox(height: AlfaSpacing.lg),
          _MaterialsSection(state: state, notifier: notifier),
          const SizedBox(height: AlfaSpacing.lg),
          _EquipmentSection(state: state, notifier: notifier),
          const SizedBox(height: AlfaSpacing.lg),
          _ContactSection(state: state, notifier: notifier),
          const SizedBox(height: AlfaSpacing.lg),
          _SignatureSection(state: state, notifier: notifier),
          const SizedBox(height: AlfaSpacing.xl),
          _CompletionSection(state: state, notifier: notifier),
          const SizedBox(height: AlfaSpacing.xxl),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Peças compartilhadas
// ---------------------------------------------------------------------------

class _Section extends StatelessWidget {
  const _Section({
    required this.title,
    required this.icon,
    required this.child,
    this.trailing,
  });

  final String title;
  final IconData icon;
  final Widget child;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(AlfaSpacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon, size: 20, color: theme.colorScheme.primary),
                const SizedBox(width: AlfaSpacing.sm),
                Expanded(
                  child: Text(
                    title,
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                ?trailing,
              ],
            ),
            const SizedBox(height: AlfaSpacing.md),
            child,
          ],
        ),
      ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.message, required this.onDismiss});

  final String message;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final status = context.statusColors;
    return Container(
      padding: const EdgeInsets.all(AlfaSpacing.md),
      decoration: BoxDecoration(
        color: status.dangerContainer,
        borderRadius: BorderRadius.circular(AlfaRadius.md),
      ),
      child: Row(
        children: [
          Icon(Icons.error_outline, color: status.danger, size: 20),
          const SizedBox(width: AlfaSpacing.sm),
          Expanded(
            child: Text(message, style: TextStyle(color: status.danger)),
          ),
          IconButton(
            icon: Icon(Icons.close, color: status.danger, size: 18),
            onPressed: onDismiss,
            tooltip: 'Dispensar',
          ),
        ],
      ),
    );
  }
}

/// Progresso simples das etapas (§47). Uma contagem, não gamificação.
class _ProgressCard extends StatelessWidget {
  const _ProgressCard({required this.bundle});

  final ExecutionBundle bundle;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final status = context.statusColors;
    final progress = bundle.progress;
    final ratio = progress.total == 0 ? 1.0 : progress.done / progress.total;
    final done = progress.done == progress.total;

    return Container(
      padding: const EdgeInsets.all(AlfaSpacing.lg),
      decoration: BoxDecoration(
        color: done ? status.successContainer : status.infoContainer,
        borderRadius: BorderRadius.circular(AlfaRadius.md),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '${progress.done} de ${progress.total} etapas concluídas',
            style: theme.textTheme.titleMedium?.copyWith(
              fontWeight: FontWeight.w700,
              color: done ? status.success : status.info,
            ),
          ),
          const SizedBox(height: AlfaSpacing.sm),
          ClipRRect(
            borderRadius: BorderRadius.circular(AlfaRadius.pill),
            child: LinearProgressIndicator(
              value: ratio,
              minHeight: 8,
              backgroundColor: theme.colorScheme.surface,
              valueColor: AlwaysStoppedAnimation(
                done ? status.success : status.info,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Localização
// ---------------------------------------------------------------------------

class _LocationSection extends StatelessWidget {
  const _LocationSection({required this.state, required this.notifier});

  final ExecutionState state;
  final ExecutionController notifier;

  @override
  Widget build(BuildContext context) {
    final status = context.statusColors;
    final location = state.bundle!.location;

    final (Color fg, Color bg, IconData icon) = switch (location.status) {
      LocationStatus.confirmed => (
        status.success,
        status.successContainer,
        Icons.verified,
      ),
      LocationStatus.unconfirmed => (
        status.warning,
        status.warningContainer,
        Icons.help_outline,
      ),
      LocationStatus.missing => (
        status.neutral,
        status.neutralContainer,
        Icons.location_off,
      ),
    };

    return _Section(
      title: 'Localização',
      icon: Icons.place_outlined,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(
              horizontal: AlfaSpacing.md,
              vertical: AlfaSpacing.sm,
            ),
            decoration: BoxDecoration(
              color: bg,
              borderRadius: BorderRadius.circular(AlfaRadius.pill),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(icon, size: 16, color: fg),
                const SizedBox(width: AlfaSpacing.xs),
                Text(
                  location.status.label,
                  style: TextStyle(color: fg, fontWeight: FontWeight.w600),
                ),
              ],
            ),
          ),
          if (location.status == LocationStatus.unconfirmed) ...[
            const SizedBox(height: AlfaSpacing.sm),
            const Text(
              'Ninguém conferiu este ponto. Ele pode não ser a porta do cliente.',
            ),
          ],
          const SizedBox(height: AlfaSpacing.md),
          Wrap(
            spacing: AlfaSpacing.sm,
            runSpacing: AlfaSpacing.sm,
            children: [
              if (location.status == LocationStatus.unconfirmed)
                FilledButton.icon(
                  onPressed: state.busy
                      ? null
                      : () => _confirm(context, notifier),
                  icon: const Icon(Icons.check),
                  label: const Text('Confirmar localização'),
                ),
              OutlinedButton.icon(
                onPressed: state.busy
                    ? null
                    : () => showCorrectLocationSheet(context, notifier),
                icon: const Icon(Icons.edit_location_alt_outlined),
                label: const Text('Corrigir'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// Confirmação com aceite EXPLÍCITO.
  ///
  /// O GPS sozinho não confirma nada: o aparelho reporta onde ELE está, não que
  /// o técnico conferiu que aquele é o ponto de instalação. O diálogo é onde a
  /// pessoa afirma isso (PRD §172).
  Future<void> _confirm(
    BuildContext context,
    ExecutionController notifier,
  ) async {
    final accepted = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Você está no endereço do cliente?'),
        content: const Text(
          'Confirmar registra que este ponto foi conferido em campo. '
          'Sua localização atual é usada apenas como referência do registro.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancelar'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Confirmar'),
          ),
        ],
      ),
    );
    if (accepted ?? false) await notifier.confirmLocation();
  }
}

// ---------------------------------------------------------------------------
// Check-in
// ---------------------------------------------------------------------------

class _CheckInSection extends StatelessWidget {
  const _CheckInSection({required this.state, required this.notifier});

  final ExecutionState state;
  final ExecutionController notifier;

  @override
  Widget build(BuildContext context) {
    final status = context.statusColors;
    final checkIn = state.bundle!.checkIn;

    return _Section(
      title: 'Check-in',
      icon: Icons.where_to_vote_outlined,
      child: checkIn == null
          ? SizedBox(
              width: double.infinity,
              height: AlfaSizing.primaryActionHeight,
              child: FilledButton.icon(
                onPressed: state.busy ? null : notifier.checkIn,
                icon: const Icon(Icons.login),
                label: const Text('FAZER CHECK-IN'),
              ),
            )
          : Row(
              children: [
                Icon(Icons.check_circle, color: status.success),
                const SizedBox(width: AlfaSpacing.sm),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Check-in realizado às ${_hhmm(checkIn.checkedInAt)}',
                        style: const TextStyle(fontWeight: FontWeight.w600),
                      ),
                      Text(
                        checkIn.distanceMeters != null
                            ? 'A ${checkIn.distanceMeters} m do ponto cadastrado'
                            : checkIn.hasCoordinate
                            ? 'Sem ponto cadastrado para comparar'
                            : 'Sem coordenada — registrado assim mesmo',
                      ),
                    ],
                  ),
                ),
              ],
            ),
    );
  }
}

String _hhmm(DateTime value) =>
    '${value.hour.toString().padLeft(2, '0')}:${value.minute.toString().padLeft(2, '0')}';

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------

class _ReportSection extends StatelessWidget {
  const _ReportSection({required this.state, required this.notifier});

  final ExecutionState state;
  final ExecutionController notifier;

  @override
  Widget build(BuildContext context) {
    final status = context.statusColors;
    final report = state.bundle!.report;

    return _Section(
      title: 'Relatório e observações',
      icon: Icons.description_outlined,
      trailing: Icon(
        report.complete ? Icons.check_circle : Icons.error_outline,
        size: 18,
        color: report.complete ? status.success : status.warning,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _field('Diagnóstico', report.diagnosis),
          const SizedBox(height: AlfaSpacing.sm),
          _field('Serviço realizado', report.workPerformed),
          if (report.notes != null && report.notes!.isNotEmpty) ...[
            const SizedBox(height: AlfaSpacing.sm),
            _field('Observações', report.notes),
          ],
          const SizedBox(height: AlfaSpacing.md),
          OutlinedButton.icon(
            onPressed: state.busy
                ? null
                : () => showReportSheet(context, notifier, report),
            icon: const Icon(Icons.edit_outlined),
            label: Text(report.complete ? 'Editar' : 'Preencher'),
          ),
        ],
      ),
    );
  }

  Widget _field(String label, String? value) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(label, style: const TextStyle(fontWeight: FontWeight.w600)),
      Text(
        value == null || value.trim().isEmpty ? 'Não preenchido' : value,
        style: TextStyle(
          fontStyle: value == null || value.trim().isEmpty
              ? FontStyle.italic
              : FontStyle.normal,
        ),
      ),
    ],
  );
}

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------

class _ChecklistSection extends StatelessWidget {
  const _ChecklistSection({required this.state, required this.notifier});

  final ExecutionState state;
  final ExecutionController notifier;

  @override
  Widget build(BuildContext context) {
    final status = context.statusColors;
    final items = state.bundle!.checklist;

    return _Section(
      title: 'Checklist',
      icon: Icons.checklist_outlined,
      child: Column(
        children: [
          for (final item in items)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Icon(
                item.answered
                    ? Icons.check_circle
                    : Icons.radio_button_unchecked,
                color: item.answered
                    ? status.success
                    : (item.required ? status.warning : status.neutral),
              ),
              title: Text(item.label),
              subtitle: Text(_subtitle(item)),
              trailing: item.type == ChecklistItemType.photo
                  // Item de foto não é respondido: ele é satisfeito ANEXANDO a
                  // foto na categoria. Um botão aqui sugeriria que dá para
                  // marcá-lo sem a evidência existir.
                  ? const Icon(Icons.photo_camera_outlined)
                  : IconButton(
                      icon: const Icon(Icons.edit_outlined),
                      onPressed: state.busy
                          ? null
                          : () => showChecklistSheet(context, notifier, item),
                      tooltip: 'Responder',
                    ),
            ),
        ],
      ),
    );
  }

  String _subtitle(ChecklistItem item) {
    if (item.type == ChecklistItemType.photo) {
      return 'Satisfeito com a foto: '
          '${EvidenceCategories.label(item.evidenceCategory)}';
    }
    if (!item.answered) {
      return item.required ? 'Obrigatório' : 'Opcional';
    }
    return switch (item.type) {
      ChecklistItemType.boolean => (item.valueBoolean ?? false) ? 'Sim' : 'Não',
      ChecklistItemType.number => item.valueNumber ?? '',
      _ => item.valueText ?? '',
    };
  }
}

// ---------------------------------------------------------------------------
// Fotos
// ---------------------------------------------------------------------------

class _PhotosSection extends StatelessWidget {
  const _PhotosSection({required this.state, required this.notifier});

  final ExecutionState state;
  final ExecutionController notifier;

  @override
  Widget build(BuildContext context) {
    final status = context.statusColors;
    final bundle = state.bundle!;
    final required = bundle.requirements.requiredEvidenceCategories;

    return _Section(
      title: 'Fotos',
      icon: Icons.photo_camera_outlined,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (required.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: AlfaSpacing.sm),
              child: Text(
                'Obrigatórias: '
                '${required.map(EvidenceCategories.label).join(", ")}',
                style: TextStyle(color: status.warning),
              ),
            ),
          if (bundle.requirements.minEvidenceCount > 0)
            Padding(
              padding: const EdgeInsets.only(bottom: AlfaSpacing.sm),
              child: Text(
                'Mínimo de ${bundle.requirements.minEvidenceCount} foto(s). '
                'Anexadas: ${bundle.evidences.length}.',
              ),
            ),

          // Fotos que ainda não chegaram ao servidor. Ficam VISÍVEIS: a §58
          // proíbe que a foto suma porque a rede caiu.
          for (final pending in state.pendingPhotos)
            _PendingPhotoTile(photo: pending, notifier: notifier),

          for (final evidence in bundle.evidences)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Icon(Icons.check_circle, color: status.success),
              title: Text(EvidenceCategories.label(evidence.category)),
              subtitle: Text(evidence.caption ?? _hhmm(evidence.createdAt)),
              trailing: IconButton(
                icon: const Icon(Icons.delete_outline),
                tooltip: 'Remover',
                onPressed: state.busy
                    ? null
                    : () => notifier.removeEvidence(evidence),
              ),
            ),

          const SizedBox(height: AlfaSpacing.sm),
          SizedBox(
            width: double.infinity,
            height: AlfaSizing.primaryActionHeight,
            child: FilledButton.icon(
              onPressed: state.busy
                  ? null
                  : () => showAddPhotoSheet(context, notifier),
              icon: const Icon(Icons.add_a_photo_outlined),
              label: const Text('ADICIONAR FOTO'),
            ),
          ),
        ],
      ),
    );
  }
}

class _PendingPhotoTile extends StatelessWidget {
  const _PendingPhotoTile({required this.photo, required this.notifier});

  final PendingPhoto photo;
  final ExecutionController notifier;

  @override
  Widget build(BuildContext context) {
    final status = context.statusColors;
    final failed = photo.status == SyncStatus.failed;

    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: failed
          ? Icon(Icons.cloud_off, color: status.danger)
          : const SizedBox(
              width: 24,
              height: 24,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
      title: Text(EvidenceCategories.label(photo.category)),
      subtitle: Text(
        failed
            // NUNCA diz "sincronizado" quando não está: a foto está no
            // aparelho, e a frase precisa deixar isso claro.
            ? 'Guardada no aparelho — não enviada. ${photo.error ?? ""}'
            : 'Enviando...',
        style: TextStyle(color: failed ? status.danger : null),
      ),
      trailing: failed
          ? Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                IconButton(
                  icon: const Icon(Icons.refresh),
                  tooltip: 'Reenviar',
                  onPressed: () => notifier.retryPhoto(photo),
                ),
                IconButton(
                  icon: const Icon(Icons.delete_outline),
                  tooltip: 'Descartar',
                  onPressed: () => notifier.discardPendingPhoto(photo),
                ),
              ],
            )
          : null,
    );
  }
}

// ---------------------------------------------------------------------------
// Materiais
// ---------------------------------------------------------------------------

class _MaterialsSection extends StatelessWidget {
  const _MaterialsSection({required this.state, required this.notifier});

  final ExecutionState state;
  final ExecutionController notifier;

  @override
  Widget build(BuildContext context) {
    final materials = state.bundle!.materials;

    return _Section(
      title: 'Materiais',
      icon: Icons.inventory_2_outlined,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (materials.isEmpty)
            const Text('Nenhum material registrado.')
          else
            for (final material in materials)
              ListTile(
                contentPadding: EdgeInsets.zero,
                dense: true,
                leading: const Icon(Icons.check, size: 18),
                title: Text(material.description),
                trailing: Text('${material.quantity} ${material.unit}'),
              ),
          const SizedBox(height: AlfaSpacing.sm),
          OutlinedButton.icon(
            onPressed: state.busy || state.stock.isEmpty
                ? null
                : () => showMaterialSheet(context, notifier, state.stock),
            icon: const Icon(Icons.add),
            label: Text(
              state.stock.isEmpty
                  ? 'Sem saldo no seu estoque'
                  : 'Registrar material',
            ),
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Equipamentos
// ---------------------------------------------------------------------------

class _EquipmentSection extends StatelessWidget {
  const _EquipmentSection({required this.state, required this.notifier});

  final ExecutionState state;
  final ExecutionController notifier;

  @override
  Widget build(BuildContext context) {
    final equipments = state.bundle!.equipments;

    return _Section(
      title: 'Equipamentos instalados',
      icon: Icons.router_outlined,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (equipments.isEmpty)
            const Text('Nenhum equipamento registrado.')
          else
            for (final equipment in equipments)
              ListTile(
                contentPadding: EdgeInsets.zero,
                dense: true,
                leading: const Icon(Icons.memory, size: 18),
                title: Text(
                  '${equipment.equipmentType}'
                  '${equipment.model != null ? " · ${equipment.model}" : ""}',
                ),
                subtitle: Text(
                  [
                    if (equipment.serial != null) 'Série ${equipment.serial}',
                    if (equipment.macAddress != null)
                      'MAC ${equipment.macAddress}',
                  ].join(' · '),
                ),
                trailing: IconButton(
                  icon: const Icon(Icons.delete_outline),
                  tooltip: 'Remover',
                  onPressed: state.busy
                      ? null
                      : () => notifier.removeEquipment(equipment),
                ),
              ),
          const SizedBox(height: AlfaSpacing.sm),
          OutlinedButton.icon(
            onPressed: state.busy
                ? null
                : () => showEquipmentSheet(context, notifier),
            icon: const Icon(Icons.add),
            label: const Text('Registrar equipamento'),
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Contato e impedimento
// ---------------------------------------------------------------------------

class _ContactSection extends StatelessWidget {
  const _ContactSection({required this.state, required this.notifier});

  final ExecutionState state;
  final ExecutionController notifier;

  @override
  Widget build(BuildContext context) {
    final bundle = state.bundle!;

    return _Section(
      title: 'Contato e impedimentos',
      icon: Icons.phone_in_talk_outlined,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final attempt in bundle.contactAttempts)
            ListTile(
              contentPadding: EdgeInsets.zero,
              dense: true,
              leading: const Icon(Icons.call_outlined, size: 18),
              title: Text(
                '${ExecutionContactAttempt.channelLabels[attempt.channel]} — '
                '${ExecutionContactAttempt.resultLabels[attempt.result]}',
              ),
              trailing: Text(_hhmm(attempt.attemptedAt)),
            ),
          for (final impediment in bundle.impediments)
            ListTile(
              contentPadding: EdgeInsets.zero,
              dense: true,
              leading: Icon(
                Icons.report_problem_outlined,
                size: 18,
                color: context.statusColors.warning,
              ),
              title: Text(
                ExecutionImpediment.reasonLabels[impediment.reason] ?? 'Outro',
              ),
              trailing: Text(_hhmm(impediment.reportedAt)),
            ),
          const SizedBox(height: AlfaSpacing.sm),
          Wrap(
            spacing: AlfaSpacing.sm,
            runSpacing: AlfaSpacing.sm,
            children: [
              OutlinedButton.icon(
                onPressed: state.busy
                    ? null
                    : () => showContactSheet(context, notifier),
                icon: const Icon(Icons.add_call),
                label: const Text('Tentativa de contato'),
              ),
              OutlinedButton.icon(
                onPressed: state.busy
                    ? null
                    : () => showImpedimentSheet(context, notifier),
                icon: const Icon(Icons.block),
                label: const Text('Não consegui executar'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Assinatura
// ---------------------------------------------------------------------------

class _SignatureSection extends StatelessWidget {
  const _SignatureSection({required this.state, required this.notifier});

  final ExecutionState state;
  final ExecutionController notifier;

  @override
  Widget build(BuildContext context) {
    final status = context.statusColors;
    final signature = state.bundle!.signature;

    return _Section(
      title: 'Assinatura do cliente',
      icon: Icons.draw_outlined,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (signature == null)
            const Text('Ainda não assinada.')
          else if (signature.stale)
            // O atendimento mudou depois da assinatura: o cliente assinou outra
            // coisa, e o servidor vai recusar a conclusão até ser recolhida de
            // novo. Dizer isso aqui evita que o técnico descubra no fim.
            Container(
              padding: const EdgeInsets.all(AlfaSpacing.md),
              decoration: BoxDecoration(
                color: status.warningContainer,
                borderRadius: BorderRadius.circular(AlfaRadius.md),
              ),
              child: Row(
                children: [
                  Icon(Icons.warning_amber, color: status.warning),
                  const SizedBox(width: AlfaSpacing.sm),
                  Expanded(
                    child: Text(
                      'O atendimento mudou depois da assinatura. '
                      'Recolha novamente.',
                      style: TextStyle(color: status.warning),
                    ),
                  ),
                ],
              ),
            )
          else
            Row(
              children: [
                Icon(Icons.check_circle, color: status.success),
                const SizedBox(width: AlfaSpacing.sm),
                Expanded(
                  child: Text(
                    'Assinada por ${signature.signerName} às '
                    '${_hhmm(signature.signedAt)}',
                  ),
                ),
              ],
            ),
          const SizedBox(height: AlfaSpacing.md),
          OutlinedButton.icon(
            onPressed: state.busy
                ? null
                : () => showSignatureSheet(context, notifier),
            icon: const Icon(Icons.draw),
            label: Text(signature == null ? 'Coletar assinatura' : 'Refazer'),
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Conclusão
// ---------------------------------------------------------------------------

class _CompletionSection extends StatelessWidget {
  const _CompletionSection({required this.state, required this.notifier});

  final ExecutionState state;
  final ExecutionController notifier;

  @override
  Widget build(BuildContext context) {
    final status = context.statusColors;
    final bundle = state.bundle!;

    /*
      A lista da ÚLTIMA tentativa vale mais que a leitura da tela.

      `completionPendencies` foi resposta a um comando real; `bundle.pendencies`
      é uma leitura que já pode ter envelhecido. Quando as duas discordam, a que
      o servidor devolveu ao comando é a verdadeira.
    */
    final pendencies = state.completionPendencies.isNotEmpty
        ? state.completionPendencies
        : bundle.pendencies;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (pendencies.isNotEmpty) ...[
          Container(
            padding: const EdgeInsets.all(AlfaSpacing.lg),
            decoration: BoxDecoration(
              color: status.warningContainer,
              borderRadius: BorderRadius.circular(AlfaRadius.md),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Não é possível concluir:',
                  style: TextStyle(
                    fontWeight: FontWeight.w700,
                    color: status.warning,
                  ),
                ),
                const SizedBox(height: AlfaSpacing.sm),
                // O texto vem do SERVIDOR. O app nunca inventa a frase, e nunca
                // mostra o código cru para o técnico.
                for (final pendency in pendencies)
                  Padding(
                    padding: const EdgeInsets.only(bottom: AlfaSpacing.xs),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('· ', style: TextStyle(color: status.warning)),
                        Expanded(
                          child: Text(
                            pendency.message,
                            style: TextStyle(color: status.warning),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: AlfaSpacing.lg),
        ],
        SizedBox(
          height: AlfaSizing.primaryActionHeight,
          child: FilledButton.icon(
            // Só habilita quando o SERVIDOR diz que não falta nada. Mesmo
            // habilitado, quem decide é a conclusão: ela revalida na própria
            // transação, e esta leitura pode estar velha.
            onPressed: state.busy || pendencies.isNotEmpty
                ? null
                : notifier.complete,
            icon: state.busy
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.task_alt),
            label: const Text('CONCLUIR ATENDIMENTO'),
          ),
        ),
      ],
    );
  }
}
