/// Configuração de ambiente do AlfaOS Field.
///
/// A URL da API **não** é constante de código nem é repetida por aí: ela entra
/// por `--dart-define` na hora do build. É o que permite o mesmo código apontar
/// para o notebook do desenvolvedor, para um servidor de homologação e para
/// produção sem editar fonte — e é o que impede um IP pessoal de virar commit.
///
/// ```bash
/// flutter run --dart-define=ALFAOS_API_BASE_URL=http://192.168.0.10:3000
/// ```
///
/// ## Por que o padrão é 10.0.2.2
///
/// `localhost`, dentro de um celular, é o próprio celular. O emulador do
/// Android expõe a máquina hospedeira em `10.0.2.2`, então esse é o único
/// padrão que funciona sem configuração.
///
/// **Num aparelho físico nem isso serve**: é preciso o IP de rede local do PC,
/// e o backend precisa escutar em `0.0.0.0`. Ver `README.md`.
class Env {
  const Env._();

  static const String apiBaseUrl = String.fromEnvironment(
    'ALFAOS_API_BASE_URL',
    defaultValue: 'http://10.0.2.2:3000',
  );

  /// Prefixo versionado da API do técnico.
  ///
  /// A versão vive no caminho porque o consumidor é um APK instalado: aparelhos
  /// com versões diferentes convivem em campo por meses, e não há como forçar
  /// atualização. Um `v2` nasce ao lado de `v1`.
  static const String apiPrefix = '/api/field/v1';

  static String get apiRoot => '$apiBaseUrl$apiPrefix';

  /// Só em debug o aplicativo escreve log de rede — e ainda assim redigido.
  static bool get isDebug {
    var debug = false;
    assert(() {
      debug = true;
      return true;
    }());
    return debug;
  }
}
