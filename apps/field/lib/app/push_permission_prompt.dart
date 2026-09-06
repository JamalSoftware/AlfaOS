import '../core/push/push_coordinator.dart';
import '../features/auth/state/session_controller.dart';

/// Mostra a folha de contexto.
///
/// `true` = quer ativar, `false` = agora não, **`null` = não havia onde
/// mostrar** — e o terceiro caso não é detalhe: sem ele, uma tela ausente
/// viraria "agora não" e a pergunta morreria sem ninguém tê-la respondido.
///
/// Injetável para que o teste não precise de árvore de widgets, e para que
/// **este objeto não conheça `BuildContext`** — quem sabe onde há uma tela viva
/// é a camada que monta o aplicativo.
typedef ShowPermissionSheet = Future<bool?> Function();

/// # Quem oferece a permissão de notificação (`NF-5`)
///
/// A `NF-2` decidiu a política e o `PushCoordinator` a implementa: perguntar
/// **depois do primeiro login**, com contexto, uma vez só. O que faltava era o
/// dono do gatilho.
///
/// ## O defeito que este objeto existe para corrigir
///
/// A oferta morava no `State` da tela de login. Só que o login bem-sucedido
/// **destrói essa tela**: assim que a sessão vira `authenticated`, o `redirect`
/// do `GoRouter` troca `/login` por `/inicio`, e a `LoginScreen` é descartada.
/// O código então chegava a consultar o estado da permissão — isso funcionava —
/// e parava na conferência de `mounted`, que já era falsa. A folha nunca
/// aparecia, o diálogo do Android nunca era pedido, e **nada falhava**: sem
/// exceção, sem log, sem sintoma. O técnico entrava e simplesmente nunca era
/// perguntado.
///
/// Encontrado no piloto físico da `NF-5`, num aparelho Android 13 com
/// `granted=false` depois de instalação limpa. Nenhum teste da trilha via, e o
/// motivo está na §"por que os testes não pegaram".
///
/// ## Por que a fase da sessão, e não a tela
///
/// O gatilho certo é o momento em que **existe alguém autenticado** — um fato
/// da sessão, não de uma tela. Amarrá-lo a qualquer tela repete o defeito na
/// próxima vez que a navegação mudar: a tela que dispara é sempre a que está
/// sendo substituída bem nesse instante.
class PushPermissionPrompt {
  PushPermissionPrompt({
    required PushCoordinator coordinator,
    required ShowPermissionSheet showSheet,
    Duration settleDelay = const Duration(milliseconds: 400),
  }) : _coordinator = coordinator,
       _showSheet = showSheet,
       _settleDelay = settleDelay;

  final PushCoordinator _coordinator;
  final ShowPermissionSheet _showSheet;

  /// Quanto se espera a navegação assentar antes de interromper.
  ///
  /// **Não é enfeite, é correção.** A troca de fase reconstrói o
  /// `routerProvider` — ele observa essa fase —, e a reconstrução leva embora
  /// qualquer rota modal empilhada no meio dela. Sem esta espera, a folha
  /// ABRIA e era descartada no mesmo instante, devolvendo "agora não" sem
  /// ninguém ter tocado em nada. Foi o segundo defeito encontrado nesta
  /// correção, e ele tem exatamente a mesma raiz da `NF-4` §27.5.
  ///
  /// A espera é por TEMPO, e não por quadro, porque esperar quadro dentro de
  /// um teste de widget prende o `pumpAndSettle`: sempre há um quadro pedido, e
  /// a suíte nunca assenta.
  ///
  /// E é boa UX de qualquer forma: deixar a tela chegar antes de interromper
  /// com um diálogo.
  final Duration _settleDelay;

  /// Já oferecemos nesta sessão?
  ///
  /// Protege contra reentrada dentro de UMA sessão. A memória de longo prazo —
  /// "esta pessoa já disse agora não" — continua sendo do `PushCoordinator`,
  /// que a guarda em disco; duplicá-la aqui criaria duas verdades.
  bool _ofereceu = false;

  /// Uma rodada em andamento. O `await` da consulta ao provedor é longo, e uma
  /// segunda troca de fase no meio dele abriria duas folhas.
  bool _emAndamento = false;

  /// A sessão mudou de fase.
  ///
  /// **Nunca lança.** Push é capability: nem a ausência de Firebase, nem a
  /// recusa da pessoa, nem uma falha do provedor podem atrapalhar quem acabou
  /// de entrar.
  Future<void> onSessionPhase(SessionPhase fase) async {
    if (fase != SessionPhase.authenticated) {
      // Sessão nova pode voltar a oferecer — quem decide se DEVE é a memória
      // do coordenador, não este sinalizador.
      _ofereceu = false;
      return;
    }
    if (_ofereceu || _emAndamento) return;

    _emAndamento = true;
    try {
      final estado = await _coordinator.prepareAfterLogin();
      if (!estado.shouldPrompt) return;

      // A navegação pós-login precisa terminar antes de a folha subir.
      await Future<void>.delayed(_settleDelay);

      final quis = await _showSheet();
      if (quis == null) {
        /*
          Não havia tela onde mostrar. NÃO se marca nada: nem aqui, nem na
          memória em disco. A pergunta continua pendente, e a próxima entrada
          tenta de novo — descartá-la em silêncio seria repetir, por outro
          caminho, exatamente o defeito que esta correção existe para
          eliminar.
        */
        return;
      }

      _ofereceu = true;
      if (quis) {
        await _coordinator.requestNow();
      } else {
        /*
          "Agora não" também marca que perguntamos. Insistir a cada login
          ensina a tocar "não" sem ler — e no Android a segunda recusa faz o
          sistema parar de exibir o diálogo, gastando a permissão de vez.
        */
        await _coordinator.declineNow();
      }
    } catch (_) {
      // Estado previsto, não falha de sessão.
    } finally {
      _emAndamento = false;
    }
  }
}
