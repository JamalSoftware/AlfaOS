import 'package:shared_preferences/shared_preferences.dart';

import 'push_coordinator.dart';

/// A marca de "já perguntamos sobre notificações", em disco.
///
/// `SharedPreferences` e não `flutter_secure_storage` de propósito: o que se
/// guarda é **um booleano sobre a interface**, não um segredo. Pôr isto no
/// armazenamento seguro daria a impressão de que há algo a proteger e
/// misturaria uma preferência de tela com o token de sessão.
///
/// Nada além do booleano é gravado. Nem o token de push, nem o e-mail, nem a
/// data — a pergunta que isto responde é só "já perguntamos?".
class SharedPrefsPushPromptMemory implements PushPromptMemory {
  const SharedPrefsPushPromptMemory();

  static const _chave = 'push_permission_asked';

  @override
  Future<bool> alreadyAsked() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getBool(_chave) ?? false;
    } catch (_) {
      /*
        Sem disco, a resposta segura é "ainda não perguntamos".

        O custo de errar para este lado é uma pergunta a mais, uma vez; errar
        para o outro lado silenciaria o push para sempre num aparelho onde o
        armazenamento falhou.
      */
      return false;
    }
  }

  @override
  Future<void> markAsked() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool(_chave, true);
    } catch (_) {
      // Não gravar significa perguntar de novo no próximo login. Incômodo,
      // não defeito — e melhor que derrubar o fluxo de entrada.
    }
  }
}

/// Memória de processo, para teste e para o caso de `SharedPreferences` faltar.
class InMemoryPushPromptMemory implements PushPromptMemory {
  bool _asked = false;

  @override
  Future<bool> alreadyAsked() async => _asked;

  @override
  Future<void> markAsked() async => _asked = true;
}
