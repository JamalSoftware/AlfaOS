import 'package:alfaos_field/app/app.dart';
import 'package:alfaos_field/app/providers.dart';
import 'package:alfaos_field/app/router.dart';
import 'package:alfaos_field/app/theme/app_theme.dart';
import 'package:alfaos_field/app/theme/theme_controller.dart';
import 'package:alfaos_field/features/auth/data/auth_repository.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_transport.dart';

/// Monta uma tela real contra o transporte falso.
///
/// Substituição de provider, **não mock de widget**: a tela, o controlador, o
/// repositório e o cliente HTTP são os de produção. O único ponto trocado é o
/// transporte — que é exatamente a fronteira que um teste não deve atravessar.
class Harness {
  Harness() : transport = FakeTransport(), store = FakeSessionStore();

  final FakeTransport transport;
  final FakeSessionStore store;

  late final ProviderContainer container;

  List<Override> get overrides {
    return [
      sessionStoreProvider.overrideWithValue(store),
      // Montado DENTRO do container, como em produção: assim o cliente recebe
      // o `SessionSignal` real e um 401 percorre o caminho verdadeiro.
      apiClientProvider.overrideWith((ref) {
        final signal = ref.watch(sessionSignalProvider);
        return buildTestClientWith(
          transport,
          store,
          onSessionEnded: signal.sessionEnded,
        );
      }),
      authRepositoryProvider.overrideWith(
        (ref) => AuthRepository(
          api: ref.watch(apiClientProvider),
          store: store,
          // `package_info_plus` depende de canal de plataforma, que não existe
          // num teste de widget. Injetar a versão mantém o repositório real.
          appVersionReader: () async => '0.1.0+1',
        ),
      ),
    ];
  }

  /// Pump de uma tela isolada, com tema real.
  ///
  /// `extraOverrides` existe para os provedores de SENSOR — GPS e câmera. Um
  /// teste de widget não tem nenhum dos dois, e sem esta porta a tela de
  /// execução, que é a mais importante do aplicativo, seria a única intestável.
  Future<void> pump(
    WidgetTester tester,
    Widget screen, {
    ThemeMode themeMode = ThemeMode.light,
    List<Override> extraOverrides = const [],
  }) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [...overrides, ...extraOverrides],
        child: MaterialApp(
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          themeMode: themeMode,
          home: screen,
        ),
      ),
    );
  }

  /// Pump do APLICATIVO inteiro, com o `GoRouter` real.
  ///
  /// Diferente de [pump]: aqui a navegação é a verdadeira — `redirect` por
  /// fase de sessão, App Shell, abas, deep link. É o único jeito de testar que
  /// a barra principal leva à tela certa e que uma sessão sem login nunca
  /// chega ao shell, porque `pump` isola uma tela e nunca exercita
  /// `routerProvider`.
  ///
  /// Não navega para lugar nenhum sozinho: `bootstrap()` dispara no primeiro
  /// frame e é ASSÍNCRONO, então navegar daqui correria contra uma sessão
  /// ainda em `bootstrapping` — e o `redirect` desfaria a navegação. Quem
  /// precisa ir a uma rota específica usa [goTo] DEPOIS de assentar a sessão.
  ///
  /// `themeMode` sobrescreve o CONTROLADOR de tema, não o `MaterialApp`: o
  /// teste percorre o mesmo caminho da produção, onde o modo vem da
  /// preferência guardada. Para trocar o tema com o aplicativo já montado, use
  /// [setTheme].
  Future<ProviderContainer> pumpApp(
    WidgetTester tester, {
    List<Override> extraOverrides = const [],
    ThemeMode? themeMode,
  }) async {
    container = ProviderContainer(
      overrides: [
        ...overrides,
        if (themeMode != null)
          themeControllerProvider.overrideWith(
            (ref) => TestThemeController(themeMode),
          ),
        ...extraOverrides,
      ],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const AlfaOsFieldApp(),
      ),
    );

    return container;
  }

  /// Navega dentro do app já pumpado — para testar uma rota alcançada de fora
  /// da barra principal (notificação, link salvo), sem correr contra o
  /// `redirect` de sessão.
  void goTo(String location) => container.read(routerProvider).go(location);

  /// Troca o tema com o aplicativo MONTADO — o cenário real do toggle.
  ///
  /// Remontar o aplicativo em outro modo não prova nada sobre a troca: uma cor
  /// resolvida uma vez nasceria certa na segunda montagem. O defeito só
  /// aparece quando a árvore existente precisa repintar.
  void setTheme(ThemeMode mode) =>
      container.read(themeControllerProvider.notifier).setMode(mode);
}

/// Controlador de tema para teste: escolhe o modo sem depender de
/// `SharedPreferences`, que num teste de widget não existe.
///
/// `setMode` continua funcionando, só não persiste. É o que permite o toggle
/// test trocar o tema com o aplicativo JÁ montado — o cenário real, em que o
/// técnico muda a preferência com a tela aberta.
class TestThemeController extends ThemeController {
  TestThemeController(ThemeMode mode) {
    state = mode;
  }

  @override
  Future<void> setMode(ThemeMode mode) async {
    state = mode;
  }
}
