import 'dart:async';

import 'field_push_service.dart';

/// Onde fica a marca de "já perguntamos uma vez".
///
/// Abstraído para o teste não depender de `shared_preferences`, e para deixar
/// explícito o que é guardado: **um booleano**. Nenhum token, nenhum
/// identificador, nenhum dado da pessoa.
abstract class PushPromptMemory {
  Future<bool> alreadyAsked();
  Future<void> markAsked();
}

/// O desfecho de uma rodada de preparação do push.
class PushPreparation {
  const PushPreparation({
    required this.status,
    required this.shouldPrompt,
    this.token,
  });

  final PushPermissionStatus status;

  /// A tela deve mostrar a explicação e oferecer ativar?
  final bool shouldPrompt;

  /// O token, quando já existe. **Nunca é impresso.**
  final String? token;

  bool get hasToken => token != null && token!.isNotEmpty;
}

/// # Quando o Field pergunta sobre notificações (`NF-2`)
///
/// Regra decidida no `NF-0` e implementada aqui: **depois do primeiro login
/// bem-sucedido, com contexto** — e nunca antes.
///
/// ## Por que não no splash
///
/// Um pedido de permissão sem contexto é recusado, e no Android a recusa é
/// lembrada: a partir da segunda negativa o sistema nem exibe mais o diálogo.
/// Perguntar cedo demais não adianta a permissão, gasta a única boa chance de
/// obtê-la.
///
/// ## Por que não a cada abertura
///
/// Insistir é a forma mais rápida de ensinar alguém a tocar "não" sem ler. A
/// marca de que já perguntamos é um booleano local — se a pessoa mudar de
/// ideia, o caminho é o ajuste do próprio sistema, que é onde o Android
/// mantém essa decisão de qualquer forma.
class PushCoordinator {
  PushCoordinator({
    required FieldPushService service,
    required PushPromptMemory memory,
  }) : _service = service,
       _memory = memory;

  final FieldPushService _service;
  final PushPromptMemory _memory;

  /// Prepara o push depois de um login bem-sucedido.
  ///
  /// **Não pergunta nada** — só descobre o estado e diz se vale a pena
  /// perguntar. Quem mostra a explicação é a tela, que é onde o contexto está.
  ///
  /// Falha de qualquer natureza vira `unavailable`: o login já aconteceu, e
  /// push é capability.
  Future<PushPreparation> prepareAfterLogin() async {
    final disponivel = await _service.initialize();
    if (!disponivel) {
      return const PushPreparation(
        status: PushPermissionStatus.unavailable,
        shouldPrompt: false,
      );
    }

    final status = await _service.permissionStatus();

    if (status == PushPermissionStatus.authorized) {
      // Já autorizado: nada a perguntar, e o token já pode existir.
      return PushPreparation(
        status: status,
        shouldPrompt: false,
        token: await _service.token(),
      );
    }

    /*
      Só se pergunta quando o sistema ainda não decidiu E ainda não
      perguntamos. `denied` NUNCA volta a perguntar por conta própria: no
      Android a decisão já está tomada, e reapresentar a explicação a cada
      login seria pedir de novo o que a plataforma não vai mais oferecer.
    */
    final podePerguntar =
        status == PushPermissionStatus.notDetermined &&
        !(await _memory.alreadyAsked());

    return PushPreparation(status: status, shouldPrompt: podePerguntar);
  }

  /// Pergunta de fato. Chamada pela tela, depois de explicar o porquê.
  ///
  /// A marca de "já perguntamos" é gravada **antes** da resposta: o que ela
  /// registra é que a pergunta foi feita, e isso é verdade mesmo que a pessoa
  /// dispense o diálogo sem escolher.
  Future<PushPreparation> requestNow() async {
    await _memory.markAsked();
    final status = await _service.requestPermission();
    if (status != PushPermissionStatus.authorized) {
      return PushPreparation(status: status, shouldPrompt: false);
    }
    return PushPreparation(
      status: status,
      shouldPrompt: false,
      token: await _service.token(),
    );
  }

  /// A pessoa escolheu "agora não". Não se pergunta de novo sozinho.
  Future<void> declineNow() => _memory.markAsked();

  /// O token novo, quando o provedor rotaciona.
  ///
  /// **`NF-2` só o expõe.** Quem o envia ao AlfaOS é o `NF-3` — a fronteira
  /// entre as duas fases está exatamente aqui, e antecipá-la faria o registro
  /// nascer sem os testes de idempotência que a fase seguinte prevê.
  Stream<String> get tokenRefresh => _service.tokenRefresh;
}
