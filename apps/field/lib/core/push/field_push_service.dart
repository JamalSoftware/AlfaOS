import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

/// # A fonte do token de push do Field (`NF-2`)
///
/// Tudo o que o aplicativo sabe sobre o Firebase passa por aqui. Nenhuma tela,
/// nenhum controller e nenhum repositório chama `FirebaseMessaging`
/// diretamente — é essa fronteira que faz o teste de widget rodar sem
/// Firebase, e é ela que vai permitir trocar de provedor sem cirurgia.
///
/// ## Três identificadores que NÃO se substituem
///
/// ```text
/// installationId   gerado pelo app, correlaciona reinstalação com a mesma
///                  linha de MobileDevice. Não é segredo e não autentica nada.
/// token de sessão  o Bearer opaco do Field. Autentica, e é revogável.
/// pushToken (FCM)  endereça UMA instalação no provedor. Rotaciona sozinho.
/// ```
///
/// Confundir os dois primeiros com o terceiro é o erro clássico da integração
/// de push: um vira identidade, o outro vira endereço, e nenhum serve para o
/// papel do outro.
///
/// ## O push é uma CAPABILITY, não um requisito
///
/// Nada aqui pode derrubar o aplicativo. Firebase sem configuração, permissão
/// negada, token indisponível — todos terminam em "push indisponível", e o
/// técnico continua abrindo OS, batendo ponto e concluindo atendimento. A
/// `Notification` interna existe de qualquer jeito, e o sino continua contando
/// o que a tela já carrega.

/// O que o sistema operacional respondeu sobre notificações.
enum PushPermissionStatus {
  /// Ainda não perguntamos, ou o sistema ainda não decidiu.
  notDetermined,

  /// Pode notificar.
  authorized,

  /// A pessoa disse não. **Não é erro**, e não se pergunta de novo sozinho.
  denied,

  /// Não há provedor de push neste aparelho ou nesta instalação.
  ///
  /// Firebase sem configuração cai aqui — o que é o estado normal enquanto o
  /// projeto oficial não existir. Deliberadamente separado de [denied]: um é
  /// decisão da pessoa, o outro é ausência de infraestrutura, e tratá-los
  /// igual faria a tela dizer "você recusou" para quem nunca foi perguntado.
  unavailable,
}

/// A fronteira. Implementada de verdade pelo Firebase e por um duplo no teste.
abstract class FieldPushService {
  /// Prepara o provedor. `false` quando não há push neste ambiente.
  ///
  /// Idempotente: chamar de novo não reinicializa nada.
  Future<bool> initialize();

  /// O que o sistema já decidiu, sem perguntar nada à pessoa.
  Future<PushPermissionStatus> permissionStatus();

  /// Pergunta à pessoa. Só deve ser chamada com contexto na tela.
  Future<PushPermissionStatus> requestPermission();

  /// O token atual, ou `null` quando não há.
  ///
  /// **Nunca** é impresso, nem em depuração: a prévia de um log acaba em
  /// arquivo, em agregador e em ticket de suporte.
  Future<String?> token();

  /// Emite o token novo quando o provedor o rotaciona.
  ///
  /// Rotação acontece sozinha — reinstalação, limpeza de dados, decisão do
  /// próprio FCM. Ignorá-la faria o aparelho parar de receber em silêncio, e
  /// ninguém descobriria até uma OS urgente não chegar.
  Stream<String> get tokenRefresh;
}

/// Não há push. Diz isso, e não finge nada.
class UnavailablePushService implements FieldPushService {
  const UnavailablePushService();

  @override
  Future<bool> initialize() async => false;

  @override
  Future<PushPermissionStatus> permissionStatus() async =>
      PushPermissionStatus.unavailable;

  @override
  Future<PushPermissionStatus> requestPermission() async =>
      PushPermissionStatus.unavailable;

  @override
  Future<String?> token() async => null;

  @override
  Stream<String> get tokenRefresh => const Stream<String>.empty();
}

/// A implementação real, sobre `firebase_core` e `firebase_messaging`.
///
/// ## Toda chamada é protegida
///
/// O `MissingPluginException` de um teste, o `FirebaseException` de um
/// aparelho sem Google Play e a ausência de `google-services.json` chegam aqui
/// como exceção. Nenhuma delas pode subir: push indisponível é um estado
/// previsto, e não uma falha do aplicativo.
class FirebasePushService implements FieldPushService {
  bool _ready = false;
  bool _tentouIniciar = false;

  @override
  Future<bool> initialize() async {
    if (_tentouIniciar) return _ready;
    _tentouIniciar = true;
    try {
      /*
        `Firebase.initializeApp()` sem opções lê a configuração nativa que o
        `google-services.json` gera. Sem o arquivo ele lança — e é exatamente o
        estado em que o AlfaOS está antes de o projeto oficial do Firebase
        existir. Por isso o retorno é `false`, e não uma exceção.
      */
      if (Firebase.apps.isEmpty) {
        await Firebase.initializeApp();
      }
      _ready = true;
    } catch (_) {
      // Sem detalhe no log: a mensagem do SDK pode conter identificadores do
      // projeto, e nada aqui é acionável pelo técnico.
      _ready = false;
    }
    return _ready;
  }

  @override
  Future<PushPermissionStatus> permissionStatus() async {
    if (!await initialize()) return PushPermissionStatus.unavailable;
    try {
      final settings = await FirebaseMessaging.instance
          .getNotificationSettings();
      return _traduzir(settings.authorizationStatus);
    } catch (_) {
      return PushPermissionStatus.unavailable;
    }
  }

  @override
  Future<PushPermissionStatus> requestPermission() async {
    if (!await initialize()) return PushPermissionStatus.unavailable;
    try {
      final settings = await FirebaseMessaging.instance.requestPermission();
      return _traduzir(settings.authorizationStatus);
    } catch (_) {
      return PushPermissionStatus.unavailable;
    }
  }

  @override
  Future<String?> token() async {
    if (!await initialize()) return null;
    try {
      return await FirebaseMessaging.instance.getToken();
    } catch (_) {
      return null;
    }
  }

  @override
  Stream<String> get tokenRefresh {
    try {
      return FirebaseMessaging.instance.onTokenRefresh;
    } catch (_) {
      return const Stream<String>.empty();
    }
  }

  /*
    `provisional` é conceito de iOS — notificação silenciosa entregue sem
    pergunta. O Field é Android hoje, e traduzir isso para "autorizado" no
    Android criaria um estado que a plataforma não produz. Fica com
    `notDetermined`, que descreve o que de fato se sabe.
  */
  PushPermissionStatus _traduzir(AuthorizationStatus status) {
    switch (status) {
      case AuthorizationStatus.authorized:
        return PushPermissionStatus.authorized;
      /*
        `deniedPermanently` é o Android depois da segunda recusa: o sistema
        deixa de exibir o diálogo. Colapsado em `denied` porque a CONDUTA é a
        mesma — não perguntar de novo —, e um estado a mais no domínio só se
        justifica quando muda o que o aplicativo faz. O caminho para quem mudar
        de ideia é o ajuste do sistema, que é onde o Android guarda a decisão.
      */
      case AuthorizationStatus.denied:
      case AuthorizationStatus.deniedPermanently:
        return PushPermissionStatus.denied;
      case AuthorizationStatus.provisional:
      case AuthorizationStatus.notDetermined:
        return PushPermissionStatus.notDetermined;
    }
  }
}

/// O serviço adequado à plataforma.
///
/// Web e desktop não têm o Field, e um `FirebasePushService` ali só produziria
/// exceção capturada em silêncio.
FieldPushService createFieldPushService() {
  if (kIsWeb) return const UnavailablePushService();
  return FirebasePushService();
}
