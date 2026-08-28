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

import 'dart:async';

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

/// Dona dos `TextEditingController` do formulário — pelo tempo de vida da ROTA.
///
/// ## O defeito que isto corrige
///
/// `showModalBottomSheet` completa o `Future` no instante do **pop**, não no
/// fim do fechamento. A folha ainda toca a animação de saída por ~200 ms, e
/// durante ela a subárvore continua montada e **reconstruindo a cada frame** —
/// com os `TextField` ainda apontando para os controladores.
///
/// O código antigo criava os controladores na função, dava `await` na folha e
/// chamava `dispose()` logo depois. Ou seja: destruía os controladores enquanto
/// campos vivos ainda os usavam.
///
/// Pelo botão de confirmar quase nunca aparecia, porque o `await` da chamada de
/// rede dava tempo de a animação terminar. Pelo **VOLTAR do Android** o
/// `dispose()` rodava no mesmo microtask do pop — e o fechamento do teclado
/// forçava reconstruções extras da folha, que batiam no controlador morto na
/// hora. Daí a tela vermelha:
///
/// > A TextEditingController was used after being disposed.
///
/// A correção é de POSSE, não de `try/catch`: quem cria é um `State` dentro da
/// rota, e quem destrói é o Flutter — depois da animação, quando o elemento sai
/// mesmo da árvore.
class _SheetFields extends StatefulWidget {
  const _SheetFields({
    required this.initial,
    required this.builder,
    this.onClosed,
    this.alsoDispose,
  });

  /// Nome do campo → texto inicial. Um controlador por chave.
  final Map<String, String> initial;

  final Widget Function(
    BuildContext context,
    Map<String, TextEditingController> fields,
  )
  builder;

  /// Texto final de cada campo, entregue **antes** de os controladores morrerem.
  ///
  /// Existe para o relatório, que salva ao fechar por qualquer via — inclusive
  /// VOLTAR e toque fora. Ler `.text` depois do `await` seria exatamente o
  /// use-after-dispose que esta classe elimina.
  final void Function(Map<String, String> values)? onClosed;

  /// Outro objeto com o mesmo ciclo de vida do formulário (a prancheta de
  /// assinatura). Morre junto, pelo mesmo motivo.
  final ChangeNotifier? alsoDispose;

  @override
  State<_SheetFields> createState() => _SheetFieldsState();
}

class _SheetFieldsState extends State<_SheetFields> {
  late final Map<String, TextEditingController> _fields = {
    for (final entry in widget.initial.entries)
      entry.key: TextEditingController(text: entry.value),
  };

  @override
  void dispose() {
    // Lê ENQUANTO ainda vivem, e só então destrói.
    widget.onClosed?.call({
      for (final entry in _fields.entries) entry.key: entry.value.text,
    });
    for (final controller in _fields.values) {
      controller.dispose();
    }
    widget.alsoDispose?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.builder(context, _fields);
}

/// Texto de um campo, já sem espaço nas pontas.
String _t(Map<String, TextEditingController> fields, String name) =>
    fields[name]!.text.trim();

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
  /*
    O relatório salva ao fechar por QUALQUER via — botão, VOLTAR ou toque fora.
    Por isso ele precisa do texto final mesmo sem confirmação, e é o único que
    usa `onClosed`.

    O `Completer` existe por uma questão de ordem: `_sheet` volta no pop, e o
    `dispose` do formulário só acontece depois da animação. Esperar por ele é o
    que garante que o texto lido é o texto final — e que ninguém toca num
    controlador já destruído.
  */
  final digitado = Completer<Map<String, String>>();

  await _sheet<void>(
    context,
    _SheetFields(
      initial: {
        'diagnosis': report.diagnosis ?? '',
        'work': report.workPerformed ?? '',
        'notes': report.notes ?? '',
      },
      onClosed: digitado.complete,
      builder: (context, fields) => SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const _SheetTitle('Relatório do atendimento'),
            TextField(
              controller: fields['diagnosis'],
              maxLines: 4,
              decoration: const InputDecoration(
                labelText: 'Diagnóstico',
                helperText: 'Obrigatório para concluir',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: AlfaSpacing.md),
            TextField(
              controller: fields['work'],
              maxLines: 4,
              decoration: const InputDecoration(
                labelText: 'Serviço realizado',
                helperText: 'Obrigatório para concluir',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: AlfaSpacing.md),
            TextField(
              controller: fields['notes'],
              maxLines: 3,
              decoration: const InputDecoration(
                labelText: 'Observações',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: AlfaSpacing.lg),
            FilledButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('Salvar'),
            ),
          ],
        ),
      ),
    ),
  );

  // Salva sempre que a folha fecha com conteúdo: perder o texto digitado por
  // causa de um toque fora seria o pior desfecho possível para o campo mais
  // trabalhoso da tela.
  final valores = await digitado.future;
  await notifier.saveReport(
    diagnosis: valores['diagnosis'] ?? '',
    workPerformed: valores['work'] ?? '',
    notes: valores['notes'] ?? '',
  );
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
  Map<String, String>? preenchido;

  // `_SheetFields` por fora, `StatefulBuilder` por dentro: os controladores
  // pertencem à rota; o motivo e o interruptor de GPS são estado local da
  // folha.
  final confirmed = await _sheet<bool>(
    context,
    _SheetFields(
      initial: const {
        'note': '',
        'address': '',
        'number': '',
        'district': '',
        'city': '',
      },
      builder: (context, fields) => StatefulBuilder(
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
                    DropdownMenuItem(
                      value: entry.key,
                      child: Text(entry.value),
                    ),
                ],
                onChanged: (value) => setState(() => reason = value ?? reason),
              ),
              if (reason == 'OTHER') ...[
                const SizedBox(height: AlfaSpacing.md),
                TextField(
                  controller: fields['note'],
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
                controller: fields['address'],
                decoration: const InputDecoration(
                  labelText: 'Logradouro',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: AlfaSpacing.sm),
              TextField(
                controller: fields['number'],
                decoration: const InputDecoration(
                  labelText: 'Número',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: AlfaSpacing.sm),
              TextField(
                controller: fields['district'],
                decoration: const InputDecoration(
                  labelText: 'Bairro',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: AlfaSpacing.sm),
              TextField(
                controller: fields['city'],
                decoration: const InputDecoration(
                  labelText: 'Cidade',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: AlfaSpacing.lg),
              FilledButton(
                // Lê os campos AQUI, com eles ainda vivos, e leva o resultado
                // no pop. Depois do `await` não há mais controlador a tocar.
                onPressed: () {
                  preenchido = {
                    'note': _t(fields, 'note'),
                    'address': _t(fields, 'address'),
                    'number': _t(fields, 'number'),
                    'district': _t(fields, 'district'),
                    'city': _t(fields, 'city'),
                  };
                  Navigator.of(context).pop(true);
                },
                child: const Text('Salvar correção'),
              ),
            ],
          ),
        ),
      ),
    ),
  );

  final valores = preenchido;
  if ((confirmed ?? false) && valores != null) {
    // Só os campos PREENCHIDOS viajam: um corpo com strings vazias apagaria o
    // resto do endereço, e o servidor trata ausência como "não mude".
    final patch = <String, String?>{
      for (final campo in ['address', 'number', 'district', 'city'])
        if ((valores[campo] ?? '').isNotEmpty) campo: valores[campo],
    };
    await notifier.correctLocation(
      reason: reason,
      note: (valores['note'] ?? '').isEmpty ? null : valores['note'],
      useCurrentPosition: useGps,
      address: patch.isEmpty ? null : patch,
    );
  }
}

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------

Future<void> showChecklistSheet(
  BuildContext context,
  ExecutionController notifier,
  ChecklistItem item,
) async {
  var boolean = item.valueBoolean ?? false;
  var selected = item.valueText;
  Map<String, String>? preenchido;

  final confirmed = await _sheet<bool>(
    context,
    _SheetFields(
      initial: {'text': item.valueText ?? '', 'number': item.valueNumber ?? ''},
      builder: (context, fields) => StatefulBuilder(
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
                  controller: fields['number'],
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
                  controller: fields['text'],
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
                    : () {
                        preenchido = {
                          'text': _t(fields, 'text'),
                          'number': _t(fields, 'number'),
                        };
                        Navigator.of(context).pop(true);
                      },
                child: const Text('Salvar resposta'),
              ),
            ],
          ),
        ),
      ),
    ),
  );

  final valores = preenchido;
  if ((confirmed ?? false) && valores != null) {
    await notifier.answerChecklist(
      item,
      valueBoolean: item.type == ChecklistItemType.boolean ? boolean : null,
      valueText: switch (item.type) {
        ChecklistItemType.text => valores['text'],
        ChecklistItemType.select => selected,
        _ => null,
      },
      valueNumber: item.type == ChecklistItemType.number
          ? num.tryParse((valores['number'] ?? '').replaceAll(',', '.'))
          : null,
    );
  }
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
  String? quantidade;

  final confirmed = await _sheet<bool>(
    context,
    _SheetFields(
      initial: const {'quantity': ''},
      builder: (context, fields) => StatefulBuilder(
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
                controller: fields['quantity'],
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
                onPressed: () {
                  quantidade = _t(fields, 'quantity');
                  Navigator.of(context).pop(true);
                },
                child: const Text('Registrar'),
              ),
            ],
          ),
        ),
      ),
    ),
  );

  final item = selected;
  final parsed = num.tryParse((quantidade ?? '').replaceAll(',', '.'));
  if ((confirmed ?? false) && item != null && parsed != null) {
    await notifier.useMaterial(itemId: item.itemId, quantity: parsed);
  }
}

// ---------------------------------------------------------------------------
// Equipamento
// ---------------------------------------------------------------------------

Future<void> showEquipmentSheet(
  BuildContext context,
  ExecutionController notifier,
) async {
  /*
    A folha devolve os VALORES, não um booleano.

    O botão lê os campos enquanto eles ainda vivem e passa o resultado no pop.
    Assim o código depois do `await` não toca em controlador nenhum — e o
    VOLTAR do Android simplesmente devolve `null`, sem nada a ler e sem nada a
    destruir na mão.
  */
  final dados = await _sheet<Map<String, String>>(
    context,
    _SheetFields(
      initial: const {
        'type': 'ONU',
        'manufacturer': '',
        'model': '',
        'serial': '',
        'mac': '',
      },
      builder: (context, fields) => SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const _SheetTitle('Equipamento instalado'),
            TextField(
              controller: fields['type'],
              decoration: const InputDecoration(
                labelText: 'Tipo (ONU, roteador, câmera...)',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: AlfaSpacing.md),
            TextField(
              controller: fields['manufacturer'],
              decoration: const InputDecoration(
                labelText: 'Fabricante',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: AlfaSpacing.md),
            TextField(
              controller: fields['model'],
              decoration: const InputDecoration(
                labelText: 'Modelo',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: AlfaSpacing.md),
            TextField(
              controller: fields['serial'],
              textCapitalization: TextCapitalization.characters,
              decoration: const InputDecoration(
                labelText: 'Número de série',
                helperText: 'Série ou MAC é obrigatório',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: AlfaSpacing.md),
            TextField(
              controller: fields['mac'],
              textCapitalization: TextCapitalization.characters,
              inputFormatters: [
                // Só o que pode existir num MAC. O servidor normaliza e valida
                // de novo — isto só evita a viagem.
                FilteringTextInputFormatter.allow(RegExp(r'[0-9A-Fa-f:\-\.]')),
              ],
              decoration: const InputDecoration(
                labelText: 'Endereço MAC',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: AlfaSpacing.lg),
            FilledButton(
              key: const Key('equipment-submit'),
              onPressed: () => Navigator.of(context).pop({
                'type': _t(fields, 'type'),
                'manufacturer': _t(fields, 'manufacturer'),
                'model': _t(fields, 'model'),
                'serial': _t(fields, 'serial'),
                'mac': _t(fields, 'mac'),
              }),
              child: const Text('Registrar'),
            ),
          ],
        ),
      ),
    ),
  );

  // VOLTAR devolve null: a folha só fecha. Nada persiste, nenhum Equipment,
  // nenhum evento, nenhuma auditoria.
  if (dados == null) return;

  await notifier.addEquipment(
    equipmentType: dados['type']!,
    manufacturer: dados['manufacturer']!,
    model: dados['model']!,
    serial: dados['serial']!,
    macAddress: dados['mac']!,
  );
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
  String? detalhes;

  final confirmed = await _sheet<bool>(
    context,
    _SheetFields(
      initial: const {'notes': ''},
      builder: (context, fields) => StatefulBuilder(
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
                    DropdownMenuItem(
                      value: entry.key,
                      child: Text(entry.value),
                    ),
                ],
                onChanged: (value) => setState(() => reason = value ?? reason),
              ),
              const SizedBox(height: AlfaSpacing.md),
              TextField(
                controller: fields['notes'],
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
                onPressed: () {
                  detalhes = _t(fields, 'notes');
                  Navigator.of(context).pop(true);
                },
                child: const Text('Registrar impedimento'),
              ),
            ],
          ),
        ),
      ),
    ),
  );

  if (confirmed ?? false) {
    await notifier.recordImpediment(
      reason: reason,
      notes: (detalhes ?? '').isEmpty ? null : detalhes,
    );
  }
}

// ---------------------------------------------------------------------------
// Assinatura
// ---------------------------------------------------------------------------

Future<void> showSignatureSheet(
  BuildContext context,
  ExecutionController notifier,
) async {
  // A prancheta tem o mesmo ciclo de vida dos campos e morre junto, pelo mesmo
  // motivo: `AnimatedBuilder` e `SignaturePad` continuam desenhando durante a
  // animação de fechamento.
  final controller = SignaturePadController();

  final result = await _sheet<({String name, List<int> bytes})>(
    context,
    _SheetFields(
      initial: const {'name': ''},
      alsoDispose: controller,
      builder: (context, fields) => StatefulBuilder(
        builder: (context, setState) => SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const _SheetTitle('Assinatura do cliente'),
              TextField(
                controller: fields['name'],
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
                            controller.hasSignature &&
                                _t(fields, 'name').isNotEmpty
                            ? () async {
                                final bytes = await controller.toPngBytes();
                                if (bytes == null || !context.mounted) return;
                                Navigator.of(
                                  context,
                                ).pop((name: _t(fields, 'name'), bytes: bytes));
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
    ),
  );

  if (result != null) {
    await notifier.signOff(signerName: result.name, pngBytes: result.bytes);
  }
}
