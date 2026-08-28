import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

/// Onde cada coisa mora, e por quê.
///
/// A separação não é organizacional, é de segurança:
///
/// - **`flutter_secure_storage`** (Keystore/EncryptedSharedPreferences) guarda
///   o **token**. É a exigência da §8.9 do `docs/SECURITY.md`: token no
///   armazenamento seguro da plataforma, nunca em arquivo de preferências.
/// - **`SharedPreferences`** guarda o que NÃO é segredo: o identificador de
///   instalação e a preferência de tema. Ambos são inúteis para um atacante e
///   precisam sobreviver a reinstalação de forma barata.
///
/// **A senha PPPoE não aparece em nenhum dos dois.** Ela é revelada sob demanda,
/// mostrada e esquecida — cache offline é armazenamento durável num aparelho
/// que anda pela rua e é roubado.
abstract class SessionStore {
  Future<String?> readToken();
  Future<void> writeToken(String token);
  Future<void> clear();

  /// Identificador de INSTALAÇÃO, criado na primeira execução.
  ///
  /// Deliberadamente um UUID aleatório: não é IMEI, não é Android ID e não é
  /// número de telefone. Número é reciclado pela operadora e pertence à pessoa
  /// — quem o receber depois passaria a receber notificação operacional da
  /// empresa (PRD §155). Não é segredo e não autentica nada.
  Future<String> installationId();
}

class SecureSessionStore implements SessionStore {
  SecureSessionStore({FlutterSecureStorage? secure, SharedPreferences? prefs})
    // O construtor padrão do `flutter_secure_storage` 11 já é o caminho forte
    // no Android: chave no Keystore, AES-GCM para o dado e RSA-OAEP para
    // envolver a chave. A opção `encryptedSharedPreferences` das versões
    // antigas deixou de existir porque virou exatamente esse padrão.
    : _secure = secure ?? const FlutterSecureStorage(),
      _prefs = prefs;

  static const _tokenKey = 'alfaos.field.token';
  static const _installationKey = 'alfaos.field.installation_id';

  final FlutterSecureStorage _secure;
  SharedPreferences? _prefs;

  Future<SharedPreferences> get _preferences async =>
      _prefs ??= await SharedPreferences.getInstance();

  @override
  Future<String?> readToken() => _secure.read(key: _tokenKey);

  @override
  Future<void> writeToken(String token) async {
    /*
      Escrita, não merge.

      Um login novo ROTACIONA o bearer no servidor: o token anterior deixa de
      valer no mesmo instante. Guardar os dois, ou falhar em substituir,
      deixaria requisições pendentes usando um valor que já morreu.
    */
    await _secure.write(key: _tokenKey, value: token);
  }

  @override
  Future<void> clear() async {
    // Só o token. O `installationId` SOBREVIVE ao logout de propósito: ele
    // identifica a instalação, não a sessão, e recriá-lo a cada saída faria o
    // servidor acumular uma linha de dispositivo por login.
    await _secure.delete(key: _tokenKey);
  }

  @override
  Future<String> installationId() async {
    final prefs = await _preferences;
    final existing = prefs.getString(_installationKey);
    if (existing != null && existing.isNotEmpty) return existing;

    final generated = const Uuid().v4();
    await prefs.setString(_installationKey, generated);
    return generated;
  }
}
