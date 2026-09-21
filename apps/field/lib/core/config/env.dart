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

  /// O padrão de desenvolvimento — e é preciso que ele seja RECONHECÍVEL.
  ///
  /// Um build de release sem `--dart-define` herdaria este valor em silêncio, e
  /// a única forma de o guarda de release saber que a URL não foi informada é
  /// comparar com a constante. `String.fromEnvironment` não distingue "não
  /// definida" de "definida com o padrão".
  static const String developmentDefault = 'http://10.0.2.2:3000';

  static const String apiBaseUrl = String.fromEnvironment(
    'ALFAOS_API_BASE_URL',
    defaultValue: developmentDefault,
  );

  /// Por que esta URL não serve para um build de RELEASE, ou `null` se serve
  /// — `SEC-013`.
  ///
  /// ## O achado
  ///
  /// `flutter build apk --release` sem `--dart-define` produzia um APK
  /// apontando para `http://10.0.2.2:3000` **sem avisar ninguém**. O endereço
  /// do emulador não existe num aparelho físico, então o aplicativo instalado
  /// simplesmente não funcionaria — e o técnico veria "sem conexão", não
  /// "aplicativo mal construído".
  ///
  /// ## O que já protegia, e o que não protegia
  ///
  /// `android:usesCleartextTraffic="true"` existe **só no manifesto de debug**,
  /// então um release já não consegue falar HTTP em texto claro: o Android
  /// bloqueia na plataforma. Isso é o que mantém o achado em severidade baixa —
  /// não havia vazamento de credencial em texto claro.
  ///
  /// O que faltava é a outra metade: **falhar alto em vez de em silêncio**. Um
  /// build mal configurado precisa se anunciar na primeira tela, para quem o
  /// instalou, e não virar um chamado de suporte sobre rede.
  ///
  /// Função pura de propósito: recebe a URL e o modo, não lê ambiente nem
  /// widget, e por isso o teste a ataca direto sem subir aplicativo.
  static String? releaseConfigurationError(String url) {
    if (url.trim().isEmpty) {
      return 'A URL da API não foi informada neste build '
          '(--dart-define=ALFAOS_API_BASE_URL).';
    }
    if (url == developmentDefault) {
      return 'Este build de release saiu com a URL padrão de '
          'DESENVOLVIMENTO. Informe --dart-define=ALFAOS_API_BASE_URL com o '
          'endereço https:// do servidor.';
    }

    final parsed = Uri.tryParse(url);
    if (parsed == null || !parsed.isAbsolute || parsed.host.isEmpty) {
      return 'A URL da API deste build não é um endereço absoluto: $url';
    }
    if (parsed.scheme != 'https') {
      // O token do técnico viaja em `Authorization: Bearer`. Em texto claro,
      // qualquer rede no caminho o lê — e o Android já recusaria a conexão.
      return 'Um build de release exige https. Esta URL usa '
          '"${parsed.scheme}": $url';
    }
    /*
      Endereço de laboratório com https continuaria sendo laboratório. O
      aparelho do técnico não alcança loopback nem o host do emulador, então
      uma URL dessas num release é erro de build, não configuração exótica.
    */
    const naoRoteaveis = {
      'localhost',
      '127.0.0.1',
      '::1',
      '10.0.2.2',
      '10.0.3.2',
    };
    if (naoRoteaveis.contains(parsed.host)) {
      return 'A URL da API deste build aponta para um endereço de '
          'desenvolvimento (${parsed.host}), que nenhum aparelho alcança.';
    }
    return null;
  }

  /// A decisão, como função PURA do modo e da URL.
  ///
  /// Existe separada do getter porque a suíte roda sempre em **debug**: uma
  /// sabotagem que fizesse `startupConfigurationError` devolver `null` sempre
  /// passava por todos os testes, já que `null` é a resposta certa em debug.
  /// O ramo de release só é testável se o modo for argumento.
  ///
  /// Em debug é sempre `null`: HTTP local é o fluxo de desenvolvimento
  /// canônico, e é ele que o piloto em aparelho físico usa, apontando para o IP
  /// da rede do notebook.
  static String? configurationErrorFor({
    required bool isDebugBuild,
    required String url,
  }) => isDebugBuild ? null : releaseConfigurationError(url);

  /// O erro de configuração que IMPEDE este build de rodar, ou `null`.
  static String? get startupConfigurationError =>
      configurationErrorFor(isDebugBuild: isDebug, url: apiBaseUrl);

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
