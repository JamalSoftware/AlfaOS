import 'package:package_info_plus/package_info_plus.dart';

import '../../../core/api/field_api_client.dart';
import '../../../core/storage/session_store.dart';
import '../domain/session.dart';

/// Autenticação e ciclo de vida do dispositivo.
///
/// Consome a autenticação REAL do Field: token opaco por Bearer, preso a um
/// `MobileDevice`. **Nada de cookie da web** — o backend nem o lê nesta
/// superfície, e um cliente nativo não teria origem para apresentar.
class AuthRepository {
  AuthRepository({
    required FieldApiClient api,
    required SessionStore store,
    Future<String> Function()? appVersionReader,
  }) : _api = api,
       _store = store,
       _appVersionReader = appVersionReader;

  final FieldApiClient _api;
  final SessionStore _store;
  final Future<String> Function()? _appVersionReader;

  /// Versão do app, lida do próprio pacote — nunca escrita à mão em dois
  /// lugares, que é como duas versões diferentes acabam sendo reportadas.
  Future<String> _appVersion() async {
    if (_appVersionReader != null) return _appVersionReader();
    final info = await PackageInfo.fromPlatform();
    return '${info.version}+${info.buildNumber}';
  }

  /// Entra e guarda o token.
  ///
  /// O corpo envia **apenas** credencial e dados da instalação. `companyId`,
  /// `userId`, `technicianId` e perfil não são enviados: quem os decide é o
  /// servidor, e mandá-los seria tentar escolher a própria autorização.
  Future<void> login({required String email, required String password}) async {
    final installationId = await _store.installationId();
    final data = await _api.post(
      '/auth/login',
      authenticated: false,
      body: {
        'email': email.trim(),
        'password': password,
        'device': {
          'platform': 'ANDROID',
          'installationId': installationId,
          'appVersion': await _appVersion(),
        },
      },
    );

    final token = data['token'] as String?;
    if (token == null || token.isEmpty) {
      throw StateError('Login sem token no corpo da resposta.');
    }
    await _store.writeToken(token);
  }

  /// Contexto atual. É a primeira chamada após o login e o que o app revalida
  /// ao voltar do background.
  Future<FieldSession> me() async {
    final data = await _api.get('/me');
    return FieldSession.fromJson(data);
  }

  /// Atualiza metadados do aparelho.
  ///
  /// É por aqui que o token de push entraria — quando o FCM existir. Hoje
  /// registra só a versão do app, que é o que o suporte precisa para saber
  /// qual APK está em campo.
  Future<void> registerDevice() async {
    await _api.post(
      '/devices/register',
      body: {'appVersion': await _appVersion()},
    );
  }

  /// Encerra a sessão.
  ///
  /// A limpeza local acontece **mesmo se a chamada falhar**. Sem rede, insistir
  /// deixaria o token válido num aparelho de onde o técnico já quis sair — e o
  /// servidor tem prazo e revogação para cobrir o resto. Sair tem de funcionar
  /// offline.
  Future<void> logout() async {
    try {
      await _api.post('/auth/logout');
    } catch (_) {
      // Intencional: o desfecho local é o mesmo.
    } finally {
      await _store.clear();
    }
  }

  Future<String?> currentToken() => _store.readToken();

  Future<void> clearSession() => _store.clear();
}
