import 'dart:async';

import 'package:flutter/foundation.dart';

import 'field_push_service.dart';
import 'push_destination.dart';

/// Onde fica a marca de "já perguntamos uma vez".
///
/// Abstraído para o teste não depender de `shared_preferences`, e para deixar
/// explícito o que é guardado: **um booleano**. Nenhum token, nenhum
/// identificador, nenhum dado da pessoa.
abstract class PushPromptMemory {
  Future<bool> alreadyAsked();
  Future<void> markAsked();
}

/// Para onde o token vai quando existe um.
///
/// É uma FUNÇÃO, e não o repositório de autenticação, de propósito: o
/// coordenador mora em `core/` e não pode enxergar `features/`. Mais que
/// camada, é responsabilidade — quem está aqui decide **quando** há um token
/// para registrar, e nada mais. Company, usuário e dono do aparelho são
/// derivados da autenticação no servidor, e o aplicativo não os envia.
typedef PushTokenSink = Future<void> Function(String token);

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
///
/// # Quem entrega o token ao AlfaOS (`NF-3`)
///
/// A `NF-2` deixou o token exposto e sem destino. Agora o coordenador também
/// **registra**, e continua sendo a única costura de push do aplicativo: uma
/// segunda classe para "mandar o token" teria de reimplementar o mesmo
/// controle de sessão, e as duas divergiriam no primeiro logout.
///
/// ## A sessão é o que liga e desliga tudo
///
/// [startSession] e [stopSession] são chamados pelo controlador de sessão, que
/// é quem sabe se existe alguém autenticado. Fora de uma sessão ativa **nada é
/// enviado** — nem pela rotação do provedor, nem por resposta atrasada. Um
/// registro sem credencial não seria só inútil: seria uma requisição que o
/// servidor recusa e que o aplicativo teria de explicar.
class PushCoordinator {
  PushCoordinator({
    required FieldPushService service,
    required PushPromptMemory memory,
    required PushTokenSink sink,
  }) : _service = service,
       _memory = memory,
       _sink = sink;

  final FieldPushService _service;
  final PushPromptMemory _memory;
  final PushTokenSink _sink;

  /// Há sessão autenticada agora?
  bool _ativa = false;

  /// A assinatura da rotação. **Uma por sessão**, nunca uma por login.
  StreamSubscription<String>? _assinatura;

  /// O último token que o servidor confirmou, **em memória**.
  ///
  /// Não é persistido (`NF-2` §26): o SDK do Firebase é a autoridade sobre o
  /// token, e uma cópia em disco só criaria uma segunda verdade para
  /// sincronizar. Aqui ele serve a uma coisa só — não repetir a mesma
  /// requisição, que é o que evita a enxurrada de auditoria do §19.
  ///
  /// **Zerado no fim da sessão**, e isso não é detalhe: o token da instalação
  /// é o mesmo para quem entrar depois. Se ele sobrevivesse ao logout, o
  /// técnico seguinte no mesmo aparelho nunca registraria o token — e o
  /// aparelho ficaria mudo para ele.
  String? _ultimoRegistrado;

  /// A abertura de sessão em curso.
  ///
  /// Existe para o teste poder esperá-la; em produção ninguém a espera, de
  /// propósito — ver a assimetria em `SessionController._apply`.
  Future<void>? _abertura;

  /// Os envios em curso, por token. É por eles que [stopSession] espera.
  ///
  /// Um MAPA, e não uma future só, por duas razões que apareceram juntas.
  ///
  /// A primeira: dois envios podem se sobrepor no caminho normal do primeiro
  /// login. `requestNow()` obtém o token recém-concedido e o entrega; o
  /// provedor emite `onTokenRefresh` com esse mesmo token quase no mesmo
  /// instante. A deduplicação por [_ultimoRegistrado] não fecha isso, porque
  /// ela só é escrita depois do SUCESSO — nesse momento ainda é nula. Guardar
  /// uma future só faria a segunda sobrescrever a primeira, e a primeira
  /// deixaria de ser esperada por qualquer um: [stopSession] retornaria, o
  /// logout limparia o `pushToken`, e a resposta órfã o gravaria de volta.
  ///
  /// A segunda: com a chave sendo o token, o envio repetido do MESMO token
  /// nem começa — ele adere ao que já está a caminho.
  final Map<String, Future<void>> _emVoo = {};

  /// Começa a acompanhar o token desta sessão.
  ///
  /// Faz duas coisas, nesta ordem: assina a rotação e tenta registrar o token
  /// que já existe. A segunda é necessária porque `onTokenRefresh` só emite
  /// enquanto o aplicativo está de pé — um token trocado com o app fechado
  /// nunca chegaria por evento, e o aparelho pararia de receber em silêncio.
  ///
  /// **Nunca lança.** Push é capability: um provedor indisponível não pode
  /// impedir ninguém de entrar.
  Future<void> startSession() {
    final abertura = _abrir();
    _abertura = abertura;
    return abertura;
  }

  Future<void> _abrir() async {
    _ativa = true;
    try {
      // Cancela antes de assinar. É isto — e não uma flag — que impede o
      // segundo login de deixar dois ouvintes vivos, cada um registrando a
      // mesma rotação.
      final anterior = _assinatura;
      _assinatura = null;
      // Mesma razão de `stopSession`: o cancelamento do canal nativo pode não
      // voltar, e a abertura de sessão não pode ficar presa nele.
      if (anterior != null) unawaited(anterior.cancel());

      final assinatura = _service.tokenRefresh.listen(_aoRotacionar);

      /*
        A sessão pode ter acabado DURANTE a linha acima.

        Quem chama não espera esta abertura (o `SessionController` a dispara
        sem `await`, porque a entrada não pode depender do push). Sem esta
        conferência, um logout que caísse entre o cancelamento e a assinatura
        deixaria um ouvinte vivo que ninguém mais cancelaria.
      */
      if (!_ativa) {
        unawaited(assinatura.cancel());
        return;
      }
      _assinatura = assinatura;
      await _registrarTokenAtual();
    } catch (_) {
      // Push indisponível é estado previsto, não falha de sessão.
    }
  }

  /// A sessão acabou: não se registra mais nada por ela.
  ///
  /// A ORDEM aqui responde à corrida do §17. Primeiro [_ativa] cai, para que
  /// nenhum envio NOVO comece. Depois se espera o que já estava em voo
  /// terminar — ainda sob a credencial que era válida quando ele saiu. Só
  /// então o chamador limpa a sessão no servidor.
  ///
  /// Inverter isso é o defeito: o logout limparia `pushToken` e, um instante
  /// depois, a resposta atrasada de um registro anterior o gravaria de volta —
  /// um aparelho de onde o técnico já saiu voltaria a ser destino de
  /// notificação.
  Future<void> stopSession() async {
    _ativa = false;

    /*
      O cancelamento NÃO é esperado, e a distinção é a razão.

      Quem garante que nada mais será enviado é `_ativa`, que já caiu na linha
      acima — `_entregar` o consulta antes de qualquer coisa. O `cancel()` é
      higiene: solta a assinatura.

      E ele pode não voltar. A rotação real é servida por um canal de
      plataforma, cujo cancelamento é uma chamada nativa que em ambiente sem
      Firebase simplesmente não responde. Esperando por ela, o `logout()`
      ficava pendurado para sempre — e sair do aplicativo é justamente a
      operação que precisa funcionar mesmo quando nada mais funciona.
    */
    final assinatura = _assinatura;
    _assinatura = null;
    if (assinatura != null) unawaited(assinatura.cancel());

    // Isto SIM é esperado: são as requisições que já saíram, sob a credencial
    // ainda válida. `_enviar` não propaga exceção, então esperar aqui não
    // derruba o logout offline.
    await Future.wait(_emVoo.values.toList());
    _ultimoRegistrado = null;
    _emVoo.clear();
  }

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
      final token = await _service.token();
      await _entregar(token);
      return PushPreparation(status: status, shouldPrompt: false, token: token);
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
  ///
  /// É aqui que o token do primeiro login costuma nascer: quando [startSession]
  /// rodou, a permissão ainda não existia e não havia o que registrar.
  Future<PushPreparation> requestNow() async {
    await _memory.markAsked();
    final status = await _service.requestPermission();
    if (status != PushPermissionStatus.authorized) {
      return PushPreparation(status: status, shouldPrompt: false);
    }
    final token = await _service.token();
    await _entregar(token);
    return PushPreparation(status: status, shouldPrompt: false, token: token);
  }

  /// A pessoa escolheu "agora não". Não se pergunta de novo sozinho.
  Future<void> declineNow() => _memory.markAsked();

  /// O token novo, quando o provedor rotaciona.
  ///
  /// Quem o consome dentro do aplicativo é [startSession], e mais ninguém:
  /// assinar por aqui receberia a rotação SEM passar pelo portão de sessão —
  /// a segunda costura que a `NF-2` removeu de propósito. Continua exposto
  /// apenas porque o teste da fundação observa a fronteira do provedor.
  @visibleForTesting
  Stream<String> get tokenRefresh => _service.tokenRefresh;

  /*
    ---------------------------------------------------------------------
    Abrir uma notificação (`NF-4`)
    ---------------------------------------------------------------------

    Estes três membros NÃO são governados por `startSession`, e a exceção é
    deliberada: um toque que ABRE o aplicativo precisa ser capturado antes de
    a sessão existir. Quem decide se pode navegar é o guarda de autenticação
    do roteador, não este objeto.
  */

  /// Identificadores de mensagens já tratadas.
  ///
  /// A plataforma pode entregar o mesmo toque mais de uma vez. Sem esta
  /// memória, o segundo viraria uma segunda navegação — e o técnico veria a
  /// mesma OS empilhada duas vezes, com dois Voltar para desfazer.
  ///
  /// Limitada de propósito: é uma janela contra repetição imediata, não um
  /// histórico. Guardar tudo faria a lista crescer com o aplicativo aberto o
  /// dia inteiro, para responder a uma pergunta que só importa por segundos.
  final _tratadas = <String>{};
  static const _limiteTratadas = 32;

  /// O toque que abriu o aplicativo fechado, quando houve um.
  ///
  /// Consultado uma vez, na subida.
  Future<PushDestination?> initialDestination() async {
    try {
      final mensagem = await _service.initialMessage();
      if (mensagem == null) return null;
      return _reconhecer(mensagem);
    } catch (_) {
      // Push é capability: falhar aqui não pode impedir o aplicativo de abrir.
      return null;
    }
  }

  /// Toques com o aplicativo em segundo plano — **intenção da pessoa**.
  ///
  /// Já vem interpretado e sem repetição: payload que não descreve destino
  /// conhecido simplesmente não aparece aqui.
  Stream<PushDestination> get opened => _service.openedApp
      .map(_reconhecer)
      .where((destino) => destino != null)
      .cast<PushDestination>();

  /// Mensagens recebidas com o aplicativo ABERTO.
  ///
  /// **Não houve toque.** Serve para atualizar estado, e quem escuta não pode
  /// navegar por causa disto — a pessoa está olhando outra tela.
  Stream<PushDestination> get received => _service.foregroundMessage
      .map((mensagem) => PushDestination.fromData(mensagem.data))
      .where((destino) => destino != null)
      .cast<PushDestination>();

  /// Interpreta e descarta repetição.
  ///
  /// A deduplicação só vale para o que ABRE tela. O `received` não passa por
  /// aqui: repetir uma atualização de estado é inofensivo, e descartá-la pelo
  /// identificador faria o aplicativo ignorar um evento legítimo que a
  /// plataforma reentregou.
  PushDestination? _reconhecer(IncomingPush mensagem) {
    final destino = PushDestination.fromData(mensagem.data);
    if (destino == null) return null;

    final id = mensagem.messageId;
    if (id != null && id.isNotEmpty) {
      if (!_tratadas.add(id)) return null;
      if (_tratadas.length > _limiteTratadas) {
        _tratadas.remove(_tratadas.first);
      }
    }
    return destino;
  }

  /// Espera o registro em voo, se houver. Existe para o teste ser
  /// determinístico — a rotação chega por evento, e sem isto a asserção
  /// correria contra o envio.
  @visibleForTesting
  Future<void> settled() async {
    // Duas voltas do laço de eventos: a rotação chega por stream, e o envio só
    // nasce quando o ouvinte roda. Esperar `_emVoo` direto devolveria `null`
    // antes de o registro sequer existir.
    for (var volta = 0; volta < 2; volta += 1) {
      await Future<void>.delayed(Duration.zero);
      await _abertura;
      await Future.wait(_emVoo.values.toList());
    }
  }

  /// O provedor trocou o token no meio da sessão.
  ///
  /// Sem sessão ativa não há assinatura viva, e o guarda de [_entregar] fecha
  /// o resto: uma rotação antes do login não pode virar requisição sem
  /// credencial.
  void _aoRotacionar(String token) {
    unawaited(_entregar(token));
  }

  /// Lê o token atual do provedor e registra, quando cabe.
  Future<void> _registrarTokenAtual() async {
    if (!await _service.initialize()) return;

    /*
      Permissão NEGADA não registra.

      No Android o `getToken()` responde mesmo sem permissão de notificação —
      o token existe, e é a ENTREGA que o sistema descarta. Registrar assim
      mesmo deixaria o banco cheio de destinos que nunca recebem, e faria
      `pushToken != null` significar "existe um endereço" em vez de "dá para
      avisar esta pessoa". A segunda é a pergunta que o worker faz.
    */
    if (await _service.permissionStatus() != PushPermissionStatus.authorized) {
      return;
    }
    await _entregar(await _service.token());
  }

  /// O portão único: tudo que vai para o servidor passa por aqui.
  Future<void> _entregar(String? token) async {
    // Sessão encerrada — inclusive a de quem saiu enquanto o provedor
    // respondia.
    if (!_ativa) return;

    /*
      Token ausente NÃO é revogação (§11).

      O contrato do `/devices/register` trata `pushToken: null` como "apague",
      e o provedor devolve `null` o tempo todo por motivo banal: ainda não
      terminou de registrar a instalação. Mandar `null` aí apagaria um token
      que funcionava. Ausência aqui significa "ainda não há", e a próxima
      oportunidade tenta de novo.
    */
    if (token == null || token.isEmpty) return;

    // Mesmo token de novo não vira requisição: é o que impede a enxurrada de
    // auditoria do §19 já na origem.
    if (token == _ultimoRegistrado) return;

    // E o mesmo token JÁ A CAMINHO também não: quem chega depois espera a
    // resposta do primeiro em vez de abrir uma segunda requisição idêntica.
    final jaEmVoo = _emVoo[token];
    if (jaEmVoo != null) return jaEmVoo;

    final envio = _enviar(token);
    _emVoo[token] = envio;
    await envio;
  }

  /// O envio propriamente dito. **Não propaga exceção.**
  ///
  /// Rede fora, prazo estourado, `401` de sessão vencida, `403` de aparelho
  /// revogado — nenhum deles é problema do técnico, e nenhum deles derruba o
  /// aplicativo. Também não marcam o token como registrado: a próxima
  /// oportunidade autenticada tenta de novo, sem laço e sem fila.
  Future<void> _enviar(String token) async {
    try {
      await _sink(token);
      _ultimoRegistrado = token;
    } catch (_) {
      // Sem detalhe no log: a mensagem pode carregar corpo de requisição.
    } finally {
      _emVoo.remove(token);
    }
  }
}
