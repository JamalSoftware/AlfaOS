import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app/app.dart';
import 'app/misconfigured_build_screen.dart';
import 'core/config/env.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();

  /*
    Um build de release mal configurado para ANTES de subir o aplicativo
    (`SEC-013`).

    Sem isto, `flutter build apk --release` sem `--dart-define` produzia um APK
    apontando para o endereço do emulador — silenciosamente. O aparelho do
    técnico não alcança aquele host, então cada tela diria "sem conexão" e a
    culpa cairia na rede.

    A verificação é a primeira coisa depois do binding: nada de provider, nada
    de Firebase, nada de sessão. Em debug ela nunca dispara, porque HTTP local é
    o fluxo de desenvolvimento canônico.
  */
  final configuracaoInvalida = Env.startupConfigurationError;
  if (configuracaoInvalida != null) {
    runApp(MisconfiguredBuildScreen(reason: configuracaoInvalida));
    return;
  }

  // Retrato primeiro: a OS é lida e operada em pé, com uma mão. Paisagem não é
  // proibida por princípio — não há razão para bloqueá-la —, mas o layout é
  // desenhado para a orientação em que o técnico realmente usa o aparelho.
  SystemChrome.setPreferredOrientations([
    DeviceOrientation.portraitUp,
    DeviceOrientation.portraitDown,
  ]);

  runApp(const ProviderScope(child: AlfaOsFieldApp()));
}
