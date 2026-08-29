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
import '../../../core/errors/field_error.dart';
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

/// Botão que só fecha a folha depois de o SERVIDOR confirmar.
///
/// ## O defeito que isto corrige
///
/// O smoke test da v0.10 registrou no servidor:
///
/// ```text
/// POST .../equipment 400
/// POST .../equipment 200
/// ```
///
/// O formulário fechava no toque, e SÓ ENTÃO o comando era enviado. Quando o
/// servidor recusava — no caso real, um equipamento sem número de série e sem
/// MAC —, o técnico já estava de volta na tela de execução, com a folha
/// fechada e tudo que digitou perdido. Do lado dele, "registrei e sumiu".
///
/// A explicação existia, mas em lugar nenhum útil: `state.error` vira um
/// banner no TOPO de uma `ListView` longa, enquanto a seção de equipamentos
/// fica no fim dela. A mensagem aparecia fora da tela.
///
/// Aqui a ordem é a inversa: envia, espera, e só fecha se deu certo. Recusa
/// mantém a folha aberta, com os dados no lugar e o motivo à vista.
class _SubmitButton extends StatefulWidget {
  const _SubmitButton({
    required this.label,
    required this.onSubmit,
    this.enabled = true,
    this.buttonKey,
  });

  final String label;

  /// `null` em caso de sucesso; a mensagem a exibir em caso de recusa.
  final Future<String?> Function() onSubmit;

  final bool enabled;
  final Key? buttonKey;

  @override
  State<_SubmitButton> createState() => _SubmitButtonState();
}

class _SubmitButtonState extends State<_SubmitButton> {
  bool _enviando = false;
  String? _erro;

  Future<void> _enviar() async {
    setState(() {
      _enviando = true;
      _erro = null;
    });

    final erro = await widget.onSubmit();
    if (!mounted) return;

    if (erro == null) {
      Navigator.of(context).pop(true);
      return;
    }
    setState(() {
      _enviando = false;
      _erro = erro;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_erro != null) ...[
          Container(
            padding: const EdgeInsets.all(AlfaSpacing.md),
            decoration: BoxDecoration(
              color: Theme.of(context).colorScheme.errorContainer,
              borderRadius: BorderRadius.circular(AlfaRadius.md),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  Icons.error_outline,
                  color: Theme.of(context).colorScheme.onErrorContainer,
                  size: 20,
                ),
                const SizedBox(width: AlfaSpacing.sm),
                Expanded(
                  child: Text(
                    _erro!,
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.onErrorContainer,
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: AlfaSpacing.md),
        ],
        FilledButton(
          key: widget.buttonKey,
          // Travado durante o envio: um toque, um comando. A idempotência do
          // servidor continua sendo a proteção de verdade — isto é só para o
          // técnico não achar que nada aconteceu e tocar de novo.
          onPressed: widget.enabled && !_enviando ? _enviar : null,
          child: _enviando
              ? const SizedBox(
                  height: 20,
                  width: 20,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : Text(widget.label),
        ),
      ],
    );
  }
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

  await _sheet<bool>(
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
              /*
                Mesmo tratamento do equipamento, e pelo mesmo motivo.

                Aqui a recusa do servidor é ainda mais provável: o saldo é
                conferido sob lock, e o número que a folha mostra pode já estar
                velho. Fechar antes da resposta significaria o técnico
                descobrir que não deu — sem a folha, sem o número digitado e
                sem o motivo à vista.
              */
              AnimatedBuilder(
                animation: fields['quantity']!,
                builder: (context, _) {
                  final parsed = num.tryParse(
                    _t(fields, 'quantity').replaceAll(',', '.'),
                  );
                  final item = selected;
                  return _SubmitButton(
                    buttonKey: const Key('material-submit'),
                    label: 'Registrar',
                    enabled: item != null && parsed != null && parsed > 0,
                    onSubmit: () async {
                      final ok = await notifier.useMaterial(
                        itemId: item!.itemId,
                        quantity: parsed!,
                      );
                      if (ok) return null;
                      final motivo = notifier.lastError;
                      notifier.consumeError();
                      return motivo ??
                          'O atendimento mudou enquanto você preenchia. '
                              'Toque em Registrar de novo.';
                    },
                  );
                },
              ),
            ],
          ),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Equipamento
// ---------------------------------------------------------------------------

Future<void> showEquipmentSheet(
  BuildContext context,
  ExecutionController notifier,
) async {
  /*
    A folha ENVIA e só fecha se o servidor aceitar.

    Antes ela devolvia os valores no pop e o comando saía depois — o que
    perdia tudo quando a resposta era 400. Agora quem fecha é o
    `_SubmitButton`, depois da confirmação; o VOLTAR do Android continua
    devolvendo `null`, sem escrever nada.

    A IDENTIFICAÇÃO é a foto da etiqueta (v0.10.1). Série e MAC continuam aqui
    porque digitar é às vezes mais rápido que enquadrar — mas nenhum dos dois é
    exigido, e o que o escritório usa para conferir depois é a imagem.
  */
  String? etiqueta;

  await _sheet<bool>(
    context,
    _SheetFields(
      initial: const {
        'type': 'ONU',
        'manufacturer': '',
        'model': '',
        'serial': '',
        'mac': '',
      },
      builder: (context, fields) => StatefulBuilder(
        builder: (context, setState) => SingleChildScrollView(
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
                  labelText: 'Número de série (opcional)',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: AlfaSpacing.md),
              TextField(
                controller: fields['mac'],
                textCapitalization: TextCapitalization.characters,
                inputFormatters: [
                  // Só o que pode existir num MAC. O servidor normaliza e
                  // valida de novo — isto só evita a viagem.
                  FilteringTextInputFormatter.allow(
                    RegExp(r'[0-9A-Fa-f:\-\.]'),
                  ),
                ],
                decoration: const InputDecoration(
                  labelText: 'Endereço MAC (opcional)',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: AlfaSpacing.lg),
              /*
                A foto da etiqueta é a evidência de identificação.

                Ela sobe SOZINHA, antes do registro, porque o equipamento
                precisa apontar para o id dela. Até esse registro acontecer ela
                fica TEMPORÁRIA no servidor: não entra na lista de fotos da OS,
                não conta para concluir, e expira se ninguém a usar. Se o
                registro falhar, ela continua disponível para a retentativa —
                o técnico corrige o formulário e reenvia sem fotografar de
                novo.

                A exceção é `LABEL_EXPIRED`: aí o prazo passou, e a saída é
                outra foto. Ver o `onSubmit` logo abaixo.
              */
              _LabelPhotoField(
                key: const Key('equipment-label-photo'),
                anexada: etiqueta != null,
                onCapture: () async {
                  final id = await notifier.captureLabelPhoto();
                  if (id != null) setState(() => etiqueta = id);
                },
              ),
              const SizedBox(height: AlfaSpacing.lg),
              _SubmitButton(
                buttonKey: const Key('equipment-submit'),
                label: 'Registrar',
                // Sem etiqueta não há identificação nenhuma — série e MAC
                // deixaram de ser exigidos junto com esta mudança.
                enabled: etiqueta != null,
                onSubmit: () async {
                  final ok = await notifier.addEquipment(
                    equipmentType: _t(fields, 'type'),
                    labelEvidenceId: etiqueta!,
                    manufacturer: _t(fields, 'manufacturer'),
                    model: _t(fields, 'model'),
                    serial: _t(fields, 'serial'),
                    macAddress: _t(fields, 'mac'),
                  );
                  if (ok) return null;

                  final motivo = notifier.lastError;
                  /*
                    Etiqueta vencida: a saída é OUTRA FOTO.

                    Insistir com a mesma imagem produziria a mesma recusa para
                    sempre. Soltar a captura devolve o formulário ao estado em
                    que ele pede a etiqueta — com o resto do que foi digitado
                    intacto, porque redigitar não é parte do problema.

                    A decisão vem do CÓDIGO do servidor, não de ler a mensagem:
                    aqui o aplicativo só reage ao que lhe foi dito.
                  */
                  if (notifier.lastErrorCode == FieldErrorCode.labelExpired) {
                    setState(() => etiqueta = null);
                  }
                  notifier.consumeError();
                  return motivo ??
                      'O atendimento mudou enquanto você preenchia. '
                          'Toque em Registrar de novo.';
                },
              ),
            ],
          ),
        ),
      ),
    ),
  );
}

/// Captura da etiqueta, com o estado dela à vista.
///
/// Um botão que só muda de rótulo não bastaria: o técnico precisa saber, sem
/// rolar nem adivinhar, se a foto que identifica o aparelho já subiu.
class _LabelPhotoField extends StatefulWidget {
  const _LabelPhotoField({
    super.key,
    required this.anexada,
    required this.onCapture,
  });

  final bool anexada;
  final Future<void> Function() onCapture;

  @override
  State<_LabelPhotoField> createState() => _LabelPhotoFieldState();
}

class _LabelPhotoFieldState extends State<_LabelPhotoField> {
  bool _enviando = false;

  Future<void> _capturar() async {
    setState(() => _enviando = true);
    await widget.onCapture();
    if (mounted) setState(() => _enviando = false);
  }

  @override
  Widget build(BuildContext context) {
    final status = context.statusColors;
    final anexada = widget.anexada;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Icon(
              anexada ? Icons.check_circle : Icons.photo_camera_outlined,
              size: 20,
              color: anexada ? status.success : status.warning,
            ),
            const SizedBox(width: AlfaSpacing.sm),
            Expanded(
              child: Text(
                anexada ? 'Etiqueta anexada' : 'Foto da etiqueta — obrigatória',
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
            ),
          ],
        ),
        const SizedBox(height: AlfaSpacing.sm),
        Text(
          anexada
              ? 'É ela que identifica este aparelho. Refaça se ficou ilegível.'
              : 'Fotografe a etiqueta ou a traseira, com série e MAC legíveis. '
                    'Assim você não precisa digitá-los.',
          style: const TextStyle(fontSize: 12),
        ),
        const SizedBox(height: AlfaSpacing.sm),
        OutlinedButton.icon(
          onPressed: _enviando ? null : _capturar,
          icon: _enviando
              ? const SizedBox(
                  height: 18,
                  width: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.photo_camera_outlined),
          label: Text(anexada ? 'REFAZER FOTO' : 'FOTOGRAFAR ETIQUETA'),
        ),
      ],
    );
  }
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
