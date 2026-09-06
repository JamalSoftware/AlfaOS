import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/push/push_coordinator.dart';
import '../core/push/push_destination.dart';
import '../features/auth/state/session_controller.dart';

/// O que o aplicativo precisa recarregar quando uma OS é atribuída em segundo
/// plano. Injetado para o teste observar **o quê** foi atualizado, sem montar
/// a árvore inteira.
typedef PushRefresh = void Function(PushDestination destino);

/// Quem sabe onde o técnico está agora.
typedef CurrentLocation = String Function();

/// Como empilhar uma rota. **Sempre o `GoRouter`** — a assinatura existe para
/// o teste, não para abrir uma segunda porta de navegação.
typedef Navigate = void Function(String route);

/// Existe sessão autenticada agora?
typedef SessionActive = bool Function();

/// # Do toque à tela (`NF-4`)
///
/// A ponte entre o provedor de push e a navegação, e o lugar onde três regras
/// se encontram: o que o payload diz, se existe sessão, e onde a pessoa está.
///
/// ## O push não abre porta nenhuma
///
/// Ele diz para onde ir; quem decide se é possível é o `redirect` do
/// `GoRouter`, que já é a única autoridade de sessão do aplicativo. Por isso
/// aqui só existe `router.push` — nunca um `Navigator` paralelo. Contornar o
/// roteador seria construir uma segunda porta, e a segunda porta é a que
/// ninguém lembra de trancar.
///
/// E mesmo depois de a tela abrir, **nada foi autorizado**: a tela de detalhe
/// consulta o servidor pelo caminho autenticado de sempre. Uma OS reatribuída
/// no minuto anterior responde 404, e é assim que tem de ser.
///
/// ## Segundo plano navega; primeiro plano NÃO
///
/// Um toque é intenção da pessoa e leva à OS. Uma mensagem que chega com o
/// aplicativo aberto **não é toque nenhum** — o técnico está no meio de um
/// atendimento, e trocar a tela debaixo da mão dele é a pior coisa que um
/// aplicativo de campo pode fazer. Ela atualiza estado, e só.
class PushNavigator {
  PushNavigator({
    required PushCoordinator coordinator,
    required CurrentLocation currentLocation,
    required Navigate navigate,
    required SessionActive sessionActive,
    required PushRefresh onPushEvent,
  }) : _coordinator = coordinator,
       _currentLocation = currentLocation,
       _navigate = navigate,
       _sessionActive = sessionActive,
       _atualizar = onPushEvent;

  final PushCoordinator _coordinator;
  final CurrentLocation _currentLocation;
  final Navigate _navigate;
  final SessionActive _sessionActive;
  final PushRefresh _atualizar;

  StreamSubscription<PushDestination>? _toques;
  StreamSubscription<PushDestination>? _recebidas;

  /// O destino que espera a sessão.
  ///
  /// **Em memória, e só.** Não vai para o disco (`NF-3` §26 vale igual aqui):
  /// se o aplicativo morrer durante o login, perder o destino é aceitável —
  /// o aviso continua na central de notificações, e o técnico chega pela lista.
  /// Persistir criaria um ponteiro para recurso de uma empresa em armazenamento
  /// que sobrevive ao logout.
  PushDestination? _pendente;

  @visibleForTesting
  PushDestination? get pendingDestination => _pendente;

  /// Liga as assinaturas. Chamado UMA vez, na subida do aplicativo.
  ///
  /// Cancela antes de assinar pela mesma razão da `NF-3`: um segundo `start`
  /// sem isto deixaria dois ouvintes, e cada toque viraria duas navegações.
  Future<void> start() async {
    await stop();
    _toques = _coordinator.opened.listen(handleTap);
    _recebidas = _coordinator.received.listen((destino) {
      // A mesma pergunta do toque, e pela mesma razão: uma mensagem em voo
      // pode chegar depois do logout, e recarregar três listas sem credencial
      // só produz três requisições recusadas.
      if (!_sessionActive()) return;
      _atualizar(destino);
    });

    // O toque que abriu o aplicativo fechado. Depois das assinaturas, para
    // que nada emitido no intervalo se perca.
    final inicial = await _coordinator.initialDestination();
    if (inicial != null) handleTap(inicial);
  }

  Future<void> stop() async {
    await _toques?.cancel();
    await _recebidas?.cancel();
    _toques = null;
    _recebidas = null;
  }

  /// A pessoa tocou numa notificação.
  void handleTap(PushDestination destino) {
    if (!_sessionActive()) {
      /*
        Sem sessão, o destino ESPERA — não se tenta navegar.

        Chamar `push` aqui funcionaria, porque o `redirect` mandaria para o
        login de qualquer jeito. Mas funcionaria por acidente: o destino se
        perderia no caminho, e o técnico que tocou num aviso de OS acabaria
        olhando a tela de entrada sem entender por quê.
      */
      _pendente = destino;
      return;
    }
    /*
      O toque relê o MESMO que a chegada em primeiro plano relê.

      Foi aqui que o piloto físico quebrou: o aplicativo encerrado recebia o
      push, o técnico tocava, chegava na OS — e o sino continuava no número
      antigo. A tela de detalhe se carrega sozinha, então o destino parecia
      certo; o que ficava velho era todo o resto.

      A diferença entre "chegou com o app aberto" e "chegou com o app
      fechado" é só se havia alguém olhando. Deixar os dados do aplicativo
      dependerem disso seria arbitrário — por isso é a mesma releitura, e não
      uma segunda menor.
    */
    _atualizar(destino);
    _navegar(destino);
  }

  /// A sessão mudou de fase. Consome o destino que esperava.
  void onSessionPhase(SessionPhase fase) {
    if (fase != SessionPhase.authenticated) {
      /*
        Login que FALHA não abre destino nenhum, e o pendente não sobrevive a
        uma sessão encerrada: um destino guardado durante o técnico A não pode
        abrir no aplicativo do técnico B, que entrou no mesmo aparelho depois.
      */
      if (fase == SessionPhase.unauthenticated ||
          fase == SessionPhase.revoked) {
        _pendente = null;
      }
      return;
    }
    final destino = _pendente;
    if (destino == null) return;
    _pendente = null;
    _navegar(destino);
  }

  void _navegar(PushDestination destino) {
    /*
      Já está lá? Então não há nada a fazer.

      Cobre dois casos com uma pergunta só: a duplicata que a plataforma
      entregou de novo, e o técnico que toca um aviso da OS que já tem aberta.
      Empilhar `/orders/123` sobre `/orders/123` obrigaria dois Voltar para
      sair de um lugar onde ele já estava.

      `startsWith` e não igualdade: quem está em `/orders/123/execucao` está
      DENTRO daquela OS, e tirá-lo da execução para mostrar o detalhe dela
      seria perder o trabalho em andamento por causa de um aviso sobre o que
      ele já está fazendo.
    */
    final atual = _currentLocation();
    if (atual == destino.route || atual.startsWith('${destino.route}/')) return;

    // Pelo roteador, sempre: é ele que carrega o guarda de sessão.
    _navigate(destino.route);
  }
}
