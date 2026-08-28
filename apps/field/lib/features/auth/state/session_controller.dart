import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/field_error.dart';
import '../data/auth_repository.dart';
import '../domain/session.dart';

/// Em que ponto do ciclo de vida a sessão está.
enum SessionPhase {
  /// Lendo o token guardado, na abertura do app.
  bootstrapping,

  /// Sem token, ou token recusado. Vai para o login.
  unauthenticated,

  /// Sessão válida.
  authenticated,

  /// O aparelho foi revogado por um administrador.
  ///
  /// Estado PRÓPRIO, separado de `unauthenticated`, porque a saída é outra:
  /// "entre de novo" é conselho inútil para quem teve o aparelho bloqueado, e
  /// deixaria a pessoa digitando a senha sem entender por que não passa.
  revoked,

  /// Há token, mas a rede falhou ao validá-lo.
  ///
  /// **Não apaga a credencial.** Internet caindo não é motivo para deslogar
  /// alguém — quem for revogado de verdade recebe 401 e cai em
  /// `unauthenticated`.
  offline,
}

@immutable
class SessionState {
  const SessionState({required this.phase, this.session, this.message});

  final SessionPhase phase;
  final FieldSession? session;

  /// Motivo a exibir, quando há um. Vem do servidor, para leitura humana.
  final String? message;

  const SessionState.bootstrapping()
    : phase = SessionPhase.bootstrapping,
      session = null,
      message = null;

  bool get isAuthenticated => phase == SessionPhase.authenticated;
}

/// Sinal de "a sessão acabou", emitido pela camada de rede.
///
/// Existe para quebrar o ciclo: o cliente HTTP precisa avisar que recebeu 401,
/// e o controlador de sessão precisa do cliente para fazer login. Ambos
/// dependem deste objeto, que não depende de ninguém.
class SessionSignal extends ChangeNotifier {
  void sessionEnded() => notifyListeners();
}

class SessionController extends StateNotifier<SessionState> {
  SessionController({
    required AuthRepository auth,
    required SessionSignal signal,
  }) : _auth = auth,
       _signal = signal,
       super(const SessionState.bootstrapping()) {
    _signal.addListener(_onSessionEnded);
  }

  final AuthRepository _auth;
  final SessionSignal _signal;

  @override
  void dispose() {
    _signal.removeListener(_onSessionEnded);
    super.dispose();
  }

  void _onSessionEnded() {
    if (state.phase == SessionPhase.revoked) return;
    state = const SessionState(
      phase: SessionPhase.unauthenticated,
      message: 'Sua sessão expirou. Entre novamente.',
    );
  }

  /// Abertura do app: existe token guardado e ele ainda vale?
  Future<void> bootstrap() async {
    state = const SessionState.bootstrapping();
    final token = await _auth.currentToken();
    if (token == null || token.isEmpty) {
      state = const SessionState(phase: SessionPhase.unauthenticated);
      return;
    }
    await _loadSession(registerDevice: false);
  }

  Future<void> login({required String email, required String password}) async {
    state = const SessionState.bootstrapping();
    try {
      await _auth.login(email: email, password: password);
    } on FieldException catch (error) {
      state = SessionState(
        phase: error.code == FieldErrorCode.deviceRevoked
            ? SessionPhase.revoked
            : SessionPhase.unauthenticated,
        message: error.message,
      );
      rethrow;
    }
    await _loadSession(registerDevice: true);
  }

  /// Carrega `/me` e, quando é login novo, registra o aparelho.
  ///
  /// O registro é feito DEPOIS do `/me` e sua falha não derruba a sessão: ele
  /// atualiza metadados (versão do app, futuro token de push), e perder isso
  /// não é motivo para impedir o técnico de trabalhar.
  Future<void> _loadSession({required bool registerDevice}) async {
    try {
      final session = await _auth.me();
      state = SessionState(phase: SessionPhase.authenticated, session: session);
      if (registerDevice) {
        try {
          await _auth.registerDevice();
        } on FieldException catch (_) {
          // Metadado. Não bloqueia o trabalho.
        }
      }
    } on FieldException catch (error) {
      switch (error.code) {
        case FieldErrorCode.deviceRevoked:
          state = SessionState(
            phase: SessionPhase.revoked,
            message: error.message,
          );
        case FieldErrorCode.network:
          // Credencial preservada de propósito.
          state = SessionState(
            phase: SessionPhase.offline,
            message: error.message,
          );
        default:
          await _auth.clearSession();
          state = SessionState(
            phase: SessionPhase.unauthenticated,
            message: error.message,
          );
      }
    }
  }

  Future<void> retryBootstrap() => bootstrap();

  Future<void> logout() async {
    await _auth.logout();
    state = const SessionState(phase: SessionPhase.unauthenticated);
  }

  /// Sai de um aparelho revogado, para a tela de login voltar a ser útil se o
  /// administrador reverter a situação com uma instalação nova.
  Future<void> dismissRevoked() async {
    await _auth.clearSession();
    state = const SessionState(phase: SessionPhase.unauthenticated);
  }
}
