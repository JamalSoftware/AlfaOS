import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../features/auth/state/session_controller.dart';
import 'providers.dart';
import 'router.dart';
import 'theme/app_theme.dart';

class AlfaOsFieldApp extends ConsumerStatefulWidget {
  const AlfaOsFieldApp({super.key});

  @override
  ConsumerState<AlfaOsFieldApp> createState() => _AlfaOsFieldAppState();
}

class _AlfaOsFieldAppState extends ConsumerState<AlfaOsFieldApp> {
  @override
  void initState() {
    super.initState();
    // Depois do primeiro frame: `bootstrap` toca no armazenamento seguro, e
    // fazer isso durante a construção da árvore travaria a abertura do app.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(themeControllerProvider.notifier).load();

      /*
        O push é ligado ANTES do bootstrap, e a ordem importa (`NF-4`).

        Se o aplicativo foi ABERTO por um toque numa notificação, o destino
        está esperando em `getInitialMessage()`. Consultá-lo depois de a sessão
        resolver funcionaria na maioria das vezes e falharia justamente no caso
        difícil: bootstrap rápido, destino ainda não lido, e o técnico caindo no
        Início sem entender por que o aviso não levou a lugar nenhum.

        Ligar antes é seguro porque o navegador NÃO navega sem sessão — ele
        guarda o destino e espera a fase mudar.
      */
      ref.read(pushNavigatorProvider).start();
      ref.read(sessionControllerProvider.notifier).bootstrap();
    });
  }

  @override
  Widget build(BuildContext context) {
    /*
      A fase da sessão é o que solta o destino pendente.

      Quem tocou num aviso sem estar autenticado passa pelo login primeiro; ao
      chegar em `authenticated`, o destino guardado é consumido. Sai daqui, e
      não do `SessionController`, porque navegar é responsabilidade da camada
      de aplicação — e porque o controlador de sessão não pode passar a
      conhecer rotas.
    */
    ref.listen<SessionPhase>(
      sessionControllerProvider.select((s) => s.phase),
      (_, fase) => ref.read(pushNavigatorProvider).onSessionPhase(fase),
    );

    final router = ref.watch(routerProvider);
    final themeMode = ref.watch(themeControllerProvider);

    return MaterialApp.router(
      title: 'AlfaOS Field',
      debugShowCheckedModeBanner: false,
      routerConfig: router,
      theme: AppTheme.light,
      darkTheme: AppTheme.dark,
      // `system` como padrão: o aparelho já sabe se é dia ou noite.
      themeMode: themeMode,
    );
  }
}
