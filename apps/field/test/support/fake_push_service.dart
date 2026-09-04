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

  void rotacionar(String novo) => _refresh.add(novo);
  void fechar() => _refresh.close();
}
