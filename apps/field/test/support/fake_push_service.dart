import 'dart:async';

import 'package:alfaos_field/core/push/field_push_service.dart';

/// Duplo roteirizado do provedor de push.
///
/// Nenhum teste toca o Firebase. A costura `FieldPushService` existe para
/// isto: o que se prova é **a decisão** — quando perguntar, quando registrar,
/// e o que acontece quando o provedor simplesmente não está lá.
///
/// Mora em `support/` porque a `NF-2` e a `NF-3` precisam do MESMO duplo: dois
/// fakes do mesmo contrato divergiriam, e o que passasse a mentir seria
/// justamente o que ninguém estivesse olhando.
class FakePushService implements FieldPushService {
  FakePushService({
    this.disponivel = true,
    this.status = PushPermissionStatus.notDetermined,
    this.tokenValue = 'tok-fake',
    this.statusAoPerguntar,
  });

  bool disponivel;
  PushPermissionStatus status;
  PushPermissionStatus? statusAoPerguntar;
  String? tokenValue;

  int initializeCalls = 0;
  int requestCalls = 0;
  int tokenCalls = 0;

  /// Quantas assinaturas da rotação já existiram, ao todo.
  int listenCount = 0;

  int _vivos = 0;

  /// Quantas assinaturas estão VIVAS agora.
  ///
  /// É este número que prova o §15: um segundo login pode assinar de novo
  /// ([listenCount] sobe), mas não pode deixar duas escutando — senão a mesma
  /// rotação vira dois registros.
  int get assinantesVivos => _vivos;

  final _refresh = StreamController<String>.broadcast();

  /// Simula uma falha do provedor em qualquer chamada.
  bool explodir = false;

  @override
  Future<bool> initialize() async {
    initializeCalls += 1;
    if (explodir) throw StateError('firebase fora do ar');
    return disponivel;
  }

  @override
  Future<PushPermissionStatus> permissionStatus() async {
    if (explodir) throw StateError('firebase fora do ar');
    return disponivel ? status : PushPermissionStatus.unavailable;
  }

  @override
  Future<PushPermissionStatus> requestPermission() async {
    requestCalls += 1;
    if (explodir) throw StateError('firebase fora do ar');
    status = statusAoPerguntar ?? PushPermissionStatus.authorized;
    return status;
  }

  @override
  Future<String?> token() async {
    tokenCalls += 1;
    if (explodir) throw StateError('firebase fora do ar');
    return tokenValue;
  }

  /*
    Cada assinatura é envelopada para que o teste veja `listen` E `cancel`.

    Um `StreamController.broadcast` cru só avisa quando o PRIMEIRO assinante
    chega e quando o ÚLTIMO sai — e é exatamente no meio disso que mora o
    defeito do §15, com dois ouvintes ativos ao mesmo tempo.
  */
  @override
  Stream<String> get tokenRefresh {
    StreamSubscription<String>? interna;
    late StreamController<String> saida;
    saida = StreamController<String>(
      onListen: () {
        listenCount += 1;
        _vivos += 1;
        interna = _refresh.stream.listen(saida.add);
      },
      onCancel: () async {
        _vivos -= 1;
        await interna?.cancel();
      },
    );
    return saida.stream;
  }

  // -------------------------------------------------------------------------
  // Os três estados do aplicativo (`NF-4`)
  // -------------------------------------------------------------------------

  /// O que `getInitialMessage()` devolve — o toque que abriu o app fechado.
  IncomingPush? mensagemInicial;

  /// Quantas vezes a mensagem inicial foi consultada.
  int initialMessageCalls = 0;

  /// Faz `initialMessage()` lançar, como um Firebase indisponível faria.
  bool explodirInicial = false;

  final _abertas = StreamController<IncomingPush>.broadcast();
  final _primeiroPlano = StreamController<IncomingPush>.broadcast();

  int _aberturasVivas = 0;
  int _primeiroPlanoVivas = 0;

  /// Assinaturas VIVAS de cada stream, agora.
  ///
  /// Contar é a única forma de provar a disciplina do §28. Observar só o
  /// comportamento não bastaria: a deduplicação do coordenador e a checagem de
  /// "já estou lá" do navegador **mascaram** ouvintes duplicados — o segundo
  /// evento é descartado e a contagem de navegações continua certa, com o
  /// defeito vivo por baixo. Foi exatamente assim que a sabotagem `G` passou
  /// na primeira tentativa.
  int get aberturasVivas => _aberturasVivas;
  int get primeiroPlanoVivas => _primeiroPlanoVivas;

  @override
  Future<IncomingPush?> initialMessage() async {
    initialMessageCalls += 1;
    if (explodirInicial) throw StateError('firebase fora do ar');
    return mensagemInicial;
  }

  @override
  Stream<IncomingPush> get openedApp =>
      _contado(_abertas, () => _aberturasVivas, (v) => _aberturasVivas = v);

  @override
  Stream<IncomingPush> get foregroundMessage => _contado(
    _primeiroPlano,
    () => _primeiroPlanoVivas,
    (v) => _primeiroPlanoVivas = v,
  );

  /// Envelopa a stream para que `listen` e `cancel` sejam observáveis.
  ///
  /// Um `broadcast` cru só avisa do PRIMEIRO assinante e do ÚLTIMO a sair — e
  /// é entre esses dois que mora o defeito de dois ouvintes ativos.
  Stream<IncomingPush> _contado(
    StreamController<IncomingPush> origem,
    int Function() ler,
    void Function(int) escrever,
  ) {
    StreamSubscription<IncomingPush>? interna;
    late StreamController<IncomingPush> saida;
    saida = StreamController<IncomingPush>(
      onListen: () {
        escrever(ler() + 1);
        interna = origem.stream.listen(saida.add);
      },
      onCancel: () async {
        escrever(ler() - 1);
        await interna?.cancel();
      },
    );
    return saida.stream;
  }

  /// A pessoa TOCOU numa notificação, com o app em segundo plano.
  void tocar(IncomingPush mensagem) => _abertas.add(mensagem);

  /// Chegou mensagem com o app aberto. **Ninguém tocou em nada.**
  void receberEmPrimeiroPlano(IncomingPush mensagem) =>
      _primeiroPlano.add(mensagem);

  void rotacionar(String novo) => _refresh.add(novo);
  void fechar() {
    _refresh.close();
    _abertas.close();
    _primeiroPlano.close();
  }
}
