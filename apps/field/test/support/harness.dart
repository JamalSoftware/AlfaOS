import 'package:alfaos_field/app/providers.dart';
import 'package:alfaos_field/app/theme/app_theme.dart';
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
}
