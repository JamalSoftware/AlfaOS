/// Formulários da execução.
///
/// Todos são `bottom sheet` com rolagem e respeitam o teclado: o técnico
/// preenche de pé, com uma mão, e um diálogo centralizado empurra o campo para
/// debaixo do teclado justamente quando ele começa a digitar.
///
/// **Nenhum valida regra de negócio.** Campo obrigatório de formulário é
/// conveniência para evitar uma ida ao servidor; saldo, duplicidade de serial,
/// obrigatoriedade por tipo e conclusão são decididos no backend.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../app/theme/tokens.dart';
import '../domain/execution.dart';
import '../state/execution_controller.dart';
import 'signature_pad.dart';

Future<T?> _sheet<T>(BuildContext context, Widget child) {
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (context) => Padding(
      padding: EdgeInsets.only(
        left: AlfaSpacing.lg,
        right: AlfaSpacing.lg,
        top: AlfaSpacing.lg,
        // Sobe com o teclado.
        bottom: MediaQuery.of(context).viewInsets.bottom + AlfaSpacing.lg,
      ),
      child: child,
    ),
  );
}

class _SheetTitle extends StatelessWidget {
  const _SheetTitle(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: AlfaSpacing.lg),
    child: Text(
      text,
      style: Theme.of(context).textTheme.titleLarge
          ?.copyWith(fontWeight: FontWeight.w700),
    ),
  );
}

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------

Future<void> showReportSheet(
  BuildContext context,
  ExecutionController notifier,
  ExecutionReport report,
) async {
  final diagnosis = TextEditingController(text: report.diagnosis ?? '');
  final work = TextEditingController(text: report.workPerformed ?? '');
  final notes = TextEditingController(text: report.notes ?? '');

  await _sheet<void>(
    context,
    SingleChildScrollView(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const _SheetTitle('Relatório do atendimento'),
          TextField(
            controller: diagnosis,
            maxLines: 4,
            decoration: const InputDecoration(
              labelText: 'Diagnóstico',
              helperText: 'Obrigatório para concluir',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: AlfaSpacing.md),
          TextField(
            controller: work,
            maxLines: 4,
            decoration: const InputDecoration(
              labelText: 'Serviço realizado',
              helperText: 'Obrigatório para concluir',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: AlfaSpacing.md),
          TextField(
            controller: notes,
            maxLines: 3,
            decoration: const InputDecoration(
              labelText: 'Observações',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: AlfaSpacing.lg),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Salvar'),
          ),
        ],
      ),
    ),
  ).then((_) async {
    // Salva sempre que a folha fecha com conteúdo: perder o texto digitado por
    // causa de um toque fora seria o pior desfecho possível para o campo mais
    // trabalhoso da tela.
    await notifier.saveReport(
      diagnosis: diagnosis.text,
      workPerformed: work.text,
      notes: notes.text,
    );
    diagnosis.dispose();
    work.dispose();
    notes.dispose();
  });
}

// ---------------------------------------------------------------------------
// Localização
// ---------------------------------------------------------------------------

const _correctionReasons = <String, String>{
  'INCORRECT_ADDRESS': 'Endereço incorreto',
  'INCORRECT_LOCATION': 'Localização incorreta',
  'CUSTOMER_MOVED': 'Cliente mudou de endereço',
  'INCOMPLETE_REGISTRATION': 'Cadastro incompleto',
  'OTHER': 'Outro motivo',
};

Future<void> showCorrectLocationSheet(
  BuildContext context,
  ExecutionController notifier,
) async {
  var reason = 'INCORRECT_LOCATION';
  var useGps = true;
  final note = TextEditingController();
  final address = TextEditingController();
  final number = TextEditingController();
  final district = TextEditingController();
  final city = TextEditingController();

  final confirmed = await _sheet<bool>(
    context,
    StatefulBuilder(
      builder: (context, setState) => SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const _SheetTitle('Corrigir endereço e localização'),
            DropdownButtonFormField<String>(
              initialValue: reason,
              decoration: const InputDecoration(
                labelText: 'Motivo',
                border: OutlineInputBorder(),
              ),
              items: [
                for (final entry in _correctionReasons.entries)
                  DropdownMenuItem(value: entry.key, child: Text(entry.value)),
              ],
              onChanged: (value) => setState(() => reason = value ?? reason),
            ),
            if (reason == 'OTHER') ...[
              const SizedBox(height: AlfaSpacing.md),
              TextField(
                controller: note,
                decoration: const InputDecoration(
                  labelText: 'Descreva o motivo',
                  // O servidor EXIGE isto quando o motivo é "outro": um motivo
                  // genérico sem explicação não informa nada.
                  helperText: 'Obrigatório para "Outro motivo"',
                  border: OutlineInputBorder(),
                ),
              ),
            ],
            const SizedBox(height: AlfaSpacing.md),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              value: useGps,
              onChanged: (value) => setState(() => useGps = value),
              title: const Text('Usar minha localização atual'),
              subtitle: const Text(
                'Marca o ponto onde você está como a localização do cliente',
              ),
            ),
            const Divider(),
            const SizedBox(height: AlfaSpacing.sm),
            const Text(
              'Endereço (deixe em branco o que não mudou)',
              style: TextStyle(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: AlfaSpacing.sm),
            TextField(
              controller: address,
              decoration: const InputDecoration(
                labelText: 'Logradouro',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: AlfaSpacing.sm),
            TextField(
              controller: number,
              decoration: const InputDecoration(
                labelText: 'Número',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: AlfaSpacing.sm),
            TextField(
              controller: district,
              decoration: const InputDecoration(
                labelText: 'Bairro',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: AlfaSpacing.sm),
            TextField(
              controller: city,
              decoration: const InputDecoration(
                labelText: 'Cidade',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: AlfaSpacing.lg),
            FilledButton(
              onPressed: () => Navigator.of(context).pop(true),
              child: const Text('Salvar correção'),
            ),
          ],
        ),
      ),
    ),
  );

  if (confirmed ?? false) {
    // Só os campos PREENCHIDOS viajam: um corpo com strings vazias apagaria o
    // resto do endereço, e o servidor trata ausência como "não mude".
    final patch = <String, String?>{
      if (address.text.trim().isNotEmpty) 'address': address.text.trim(),
      if (number.text.trim().isNotEmpty) 'number': number.text.trim(),
      if (district.text.trim().isNotEmpty) 'district': district.text.trim(),
      if (city.text.trim().isNotEmpty) 'city': city.text.trim(),
    };
    await notifier.correctLocation(
      reason: reason,
      note: note.text.trim().isEmpty ? null : note.text.trim(),
      useCurrentPosition: useGps,
      address: patch.isEmpty ? null : patch,
    );
  }

  note.dispose();
  address.dispose();
  number.dispose();
  district.dispose();
  city.dispose();
}

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------

Future<void> showChecklistSheet(
  BuildContext context,
  ExecutionController notifier,
  ChecklistItem item,
) async {
  final text = TextEditingController(text: item.valueText ?? '');
  final number = TextEditingController(text: item.valueNumber ?? '');
  var boolean = item.valueBoolean ?? false;
  var selected = item.valueText;

  final confirmed = await _sheet<bool>(
    context,
    StatefulBuilder(
      builder: (context, setState) => SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _SheetTitle(item.label),
            if (item.description != null) ...[
              Text(item.description!),
              const SizedBox(height: AlfaSpacing.md),
            ],
            switch (item.type) {
              ChecklistItemType.boolean => SwitchListTile(
                contentPadding: EdgeInsets.zero,
                value: boolean,
                onChanged: (value) => setState(() => boolean = value),
                title: Text(boolean ? 'Sim' : 'Não'),
              ),
              ChecklistItemType.number => TextField(
                controller: number,
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                  signed: true,
                ),
                decoration: const InputDecoration(
                  labelText: 'Valor',
                  border: OutlineInputBorder(),
                ),
              ),
              // `RadioGroup` em vez de `groupValue`/`onChanged` por rádio: a
              // API antiga foi depreciada no Flutter 3.32, e repetir o estado
              // em cada item é o que ela tornava fácil errar.
              ChecklistItemType.select => RadioGroup<String>(
                groupValue: selected,
                onChanged: (value) => setState(() => selected = value),
                child: Column(
                  children: [
                    for (final option in item.options)
                      RadioListTile<String>(
                        contentPadding: EdgeInsets.zero,
                        value: option,
                        title: Text(option),
                      ),
                  ],
                ),
              ),
              ChecklistItemType.text => TextField(
                controller: text,
                maxLines: 3,
                decoration: const InputDecoration(
                  labelText: 'Resposta',
                  border: OutlineInputBorder(),
                ),
              ),
              // Item de foto não chega aqui: ele é satisfeito anexando a
              // evidência na categoria correspondente.
              ChecklistItemType.photo => const Text(
                'Este item é satisfeito anexando a foto na categoria indicada.',
              ),
            },
            const SizedBox(height: AlfaSpacing.lg),
            FilledButton(
              onPressed: item.type == ChecklistItemType.photo
                  ? null
                  : () => Navigator.of(context).pop(true),
              child: const Text('Salvar resposta'),
            ),
          ],
        ),
      ),
    ),
  );

  if (confirmed ?? false) {
    await notifier.answerChecklist(
      item,
      valueBoolean: item.type == ChecklistItemType.boolean ? boolean : null,
      valueText: switch (item.type) {
        ChecklistItemType.text => text.text.trim(),
        ChecklistItemType.select => selected,
        _ => null,
      },
      valueNumber: item.type == ChecklistItemType.number
          ? num.tryParse(number.text.replaceAll(',', '.'))
          : null,
    );
  }

  text.dispose();
  number.dispose();
}

// ---------------------------------------------------------------------------
// Fotos
// ---------------------------------------------------------------------------

Future<void> showAddPhotoSheet(
  BuildContext context,
  ExecutionController notifier,
) async {
  final choice = await _sheet<({String category, bool gallery})>(
    context,
    SingleChildScrollView(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const _SheetTitle('Que foto é esta?'),
          // A categoria é escolhida ANTES de abrir a câmera: escolhida depois,
          // o técnico já estaria com a foto na mão e marcaria qualquer coisa
          // para seguir adiante — e um álbum sem rótulo não prova nada seis
          // meses depois (PRD §162).
          for (final entry in EvidenceCategories.all.entries)
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(entry.value),
              trailing: const Icon(Icons.photo_camera_outlined),
              onTap: () =>
                  Navigator.of(context)
                      .pop((category: entry.key, gallery: false)),
              onLongPress: () =>
                  Navigator.of(context)
                      .pop((category: entry.key, gallery: true)),
            ),
          const SizedBox(height: AlfaSpacing.sm),
          const Text(
            'Toque para usar a câmera. Toque longo para escolher da galeria.',
            style: TextStyle(fontSize: 12),
          ),
        ],
      ),
    ),
  );

  if (choice != null) {
    await notifier.addPhoto(choice.category, fromGallery: choice.gallery);
  }
}

// ---------------------------------------------------------------------------
// Materiais
// ---------------------------------------------------------------------------

Future<void> showMaterialSheet(
  BuildContext context,
  ExecutionController notifier,
  List<StockLine> stock,
) async {
  StockLine? selected = stock.isNotEmpty ? stock.first : null;
  final quantity = TextEditingController();

  final confirmed = await _sheet<bool>(
    context,
    StatefulBuilder(
      builder: (context, setState) => SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const _SheetTitle('Registrar material'),
            DropdownButtonFormField<StockLine>(
              initialValue: selected,
              isExpanded: true,
              decoration: const InputDecoration(
                labelText: 'Item do seu estoque',
                border: OutlineInputBorder(),
              ),
              items: [
                for (final line in stock)
                  DropdownMenuItem(
                    value: line,
                    child: Text(
                      '${line.name} · ${line.balance} ${line.unit}',
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
              ],
              onChanged: (value) => setState(() => selected = value),
            ),
            const SizedBox(height: AlfaSpacing.md),
            TextField(
              controller: quantity,
              keyboardType: const TextInputType.numberWithOptions(
                decimal: true,
              ),
              decoration: InputDecoration(
                labelText: 'Quantidade',
                // O saldo é ORIENTAÇÃO. Quem valida é o servidor, sob lock —
                // este número pode estar velho quando o comando chegar.
                helperText: selected == null
                    ? null
                    : 'Disponível: ${selected!.balance} ${selected!.unit}',
                border: const OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: AlfaSpacing.lg),
            FilledButton(
              onPressed: () => Navigator.of(context).pop(true),
              child: const Text('Registrar'),
            ),
          ],
        ),
      ),
    ),
  );

  final item = selected;
  final parsed = num.tryParse(quantity.text.replaceAll(',', '.'));
  if ((confirmed ?? false) && item != null && parsed != null) {
    await notifier.useMaterial(itemId: item.itemId, quantity: parsed);
  }
  quantity.dispose();
}

// ---------------------------------------------------------------------------
// Equipamento
// ---------------------------------------------------------------------------

Future<void> showEquipmentSheet(
  BuildContext context,
  ExecutionController notifier,
) async {
  final type = TextEditingController(text: 'ONU');
  final manufacturer = TextEditingController();
  final model = TextEditingController();
  final serial = TextEditingController();
  final mac = TextEditingController();

  final confirmed = await _sheet<bool>(
    context,
    SingleChildScrollView(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const _SheetTitle('Equipamento instalado'),
          TextField(
            controller: type,
            decoration: const InputDecoration(
              labelText: 'Tipo (ONU, roteador, câmera...)',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: AlfaSpacing.md),
          TextField(
            controller: manufacturer,
            decoration: const InputDecoration(
              labelText: 'Fabricante',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: AlfaSpacing.md),
          TextField(
            controller: model,
            decoration: const InputDecoration(
              labelText: 'Modelo',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: AlfaSpacing.md),
          TextField(
            controller: serial,
            textCapitalization: TextCapitalization.characters,
            decoration: const InputDecoration(
              labelText: 'Número de série',
              helperText: 'Série ou MAC é obrigatório',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: AlfaSpacing.md),
          TextField(
            controller: mac,
            textCapitalization: TextCapitalization.characters,
            inputFormatters: [
              // Só o que pode existir num MAC. O servidor normaliza e valida de
              // novo — isto só evita a viagem.
              FilteringTextInputFormatter.allow(RegExp(r'[0-9A-Fa-f:\-\.]')),
            ],
            decoration: const InputDecoration(
              labelText: 'Endereço MAC',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: AlfaSpacing.lg),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Registrar'),
          ),
        ],
      ),
    ),
  );

  if (confirmed ?? false) {
    await notifier.addEquipment(
      equipmentType: type.text.trim(),
      manufacturer: manufacturer.text.trim(),
      model: model.text.trim(),
      serial: serial.text.trim(),
      macAddress: mac.text.trim(),
    );
  }

  type.dispose();
  manufacturer.dispose();
  model.dispose();
  serial.dispose();
  mac.dispose();
}

// ---------------------------------------------------------------------------
// Contato e impedimento
// ---------------------------------------------------------------------------

Future<void> showContactSheet(
  BuildContext context,
  ExecutionController notifier,
) async {
  var channel = 'PHONE_CALL';
  var result = 'NO_ANSWER';

  final confirmed = await _sheet<bool>(
    context,
    StatefulBuilder(
      builder: (context, setState) => SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const _SheetTitle('Tentativa de contato'),
            DropdownButtonFormField<String>(
              initialValue: channel,
              decoration: const InputDecoration(
                labelText: 'Como tentou',
                border: OutlineInputBorder(),
              ),
              items: [
                for (final entry
                    in ExecutionContactAttempt.channelLabels.entries)
                  DropdownMenuItem(value: entry.key, child: Text(entry.value)),
              ],
              onChanged: (value) => setState(() => channel = value ?? channel),
            ),
            const SizedBox(height: AlfaSpacing.md),
            DropdownButtonFormField<String>(
              initialValue: result,
              decoration: const InputDecoration(
                labelText: 'No que deu',
                border: OutlineInputBorder(),
              ),
              items: [
                for (final entry
                    in ExecutionContactAttempt.resultLabels.entries)
                  DropdownMenuItem(value: entry.key, child: Text(entry.value)),
              ],
              onChanged: (value) => setState(() => result = value ?? result),
            ),
            const SizedBox(height: AlfaSpacing.md),
            // Sem campo de conteúdo da conversa: registrar QUE houve contato é
            // dado operacional; registrar o que foi dito é outra categoria de
            // coisa, com outras obrigações de LGPD (PRD §113).
            const Text(
              'Registra que houve a tentativa. O conteúdo da conversa não é '
              'gravado.',
              style: TextStyle(fontSize: 12),
            ),
            const SizedBox(height: AlfaSpacing.lg),
            FilledButton(
              onPressed: () => Navigator.of(context).pop(true),
              child: const Text('Registrar'),
            ),
          ],
        ),
      ),
    ),
  );

  if (confirmed ?? false) {
    await notifier.recordContact(channel: channel, result: result);
  }
}

Future<void> showImpedimentSheet(
  BuildContext context,
  ExecutionController notifier,
) async {
  var reason = 'CUSTOMER_ABSENT';
  final notes = TextEditingController();

  final confirmed = await _sheet<bool>(
    context,
    StatefulBuilder(
      builder: (context, setState) => SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const _SheetTitle('Não consegui executar'),
            // A OS NÃO fecha aqui. Registrar o impedimento é a terceira saída,
            // entre concluir o que não foi feito e deixar a OS aberta sem
            // explicação (PRD §169).
            const Text(
              'A OS continua em andamento. Isto registra o motivo para o '
              'despachante.',
            ),
            const SizedBox(height: AlfaSpacing.md),
            DropdownButtonFormField<String>(
              initialValue: reason,
              isExpanded: true,
              decoration: const InputDecoration(
                labelText: 'Motivo',
                border: OutlineInputBorder(),
              ),
              items: [
                for (final entry in ExecutionImpediment.reasonLabels.entries)
                  DropdownMenuItem(value: entry.key, child: Text(entry.value)),
              ],
              onChanged: (value) => setState(() => reason = value ?? reason),
            ),
            const SizedBox(height: AlfaSpacing.md),
            TextField(
              controller: notes,
              maxLines: 3,
              decoration: InputDecoration(
                labelText: 'Detalhes',
                helperText: reason == 'OTHER'
                    ? 'Obrigatório para "Outro"'
                    : null,
                border: const OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: AlfaSpacing.lg),
            FilledButton(
              onPressed: () => Navigator.of(context).pop(true),
              child: const Text('Registrar impedimento'),
            ),
          ],
        ),
      ),
    ),
  );

  if (confirmed ?? false) {
    await notifier.recordImpediment(
      reason: reason,
      notes: notes.text.trim().isEmpty ? null : notes.text.trim(),
    );
  }
  notes.dispose();
}

// ---------------------------------------------------------------------------
// Assinatura
// ---------------------------------------------------------------------------

Future<void> showSignatureSheet(
  BuildContext context,
  ExecutionController notifier,
) async {
  final controller = SignaturePadController();
  final name = TextEditingController();

  final result = await _sheet<({String name, List<int> bytes})>(
    context,
    StatefulBuilder(
      builder: (context, setState) => SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const _SheetTitle('Assinatura do cliente'),
            TextField(
              controller: name,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(
                labelText: 'Nome de quem assina',
                border: OutlineInputBorder(),
              ),
              onChanged: (_) => setState(() {}),
            ),
            const SizedBox(height: AlfaSpacing.md),
            SignaturePad(controller: controller),
            const SizedBox(height: AlfaSpacing.sm),
            AnimatedBuilder(
              animation: controller,
              builder: (context, _) => Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: controller.clear,
                      icon: const Icon(Icons.cleaning_services_outlined),
                      label: const Text('LIMPAR'),
                    ),
                  ),
                  const SizedBox(width: AlfaSpacing.sm),
                  Expanded(
                    child: FilledButton.icon(
                      // Assinatura vazia não é assinatura, e um PNG de um
                      // pixel é uma imagem válida que o servidor aceitaria: a
                      // conferência de "houve traço" é do aplicativo, que é
                      // quem sabe.
                      onPressed:
                          controller.hasSignature && name.text.trim().isNotEmpty
                          ? () async {
                              final bytes = await controller.toPngBytes();
                              if (bytes == null || !context.mounted) return;
                              Navigator.of(context)
                                  .pop((name: name.text.trim(), bytes: bytes));
                            }
                          : null,
                      icon: const Icon(Icons.check),
                      label: const Text('CONFIRMAR'),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: AlfaSpacing.sm),
            const Text(
              'A assinatura confirma o recebimento e a execução do serviço.',
              style: TextStyle(fontSize: 12),
            ),
          ],
        ),
      ),
    ),
  );

  if (result != null) {
    await notifier.signOff(signerName: result.name, pngBytes: result.bytes);
  }

  controller.dispose();
  name.dispose();
}
