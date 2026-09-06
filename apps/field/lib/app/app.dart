import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../features/auth/state/session_controller.dart';
import '../features/notifications/state/notifications_controller.dart';
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
    ref.listen<SessionPhase>(sessionControllerProvider.select((s) => s.phase), (
      _,
      fase,
    ) {
      ref.read(pushNavigatorProvider).onSessionPhase(fase);
      /*
          E é aqui que a permissão de notificação é oferecida (`NF-5`).

          Antes ela morava no `State` da tela de login — a única tela que o
          login bem-sucedido garantidamente destrói. A oferta chegava a
          consultar o estado da permissão e parava na conferência de `mounted`,
          sem exceção e sem log: o técnico entrava e nunca era perguntado.

          O gatilho certo é a FASE DA SESSÃO, que é o fato que a oferta
          realmente depende, e este ponto sobrevive a qualquer troca de tela.
        */
      ref.read(pushPermissionPromptProvider).onSessionPhase(fase);

      /*
        E o SINO acompanha a sessão, não o push (`NF-5`).

        Até aqui a contagem só era lida em dois lugares: quando um push chegava
        com o aplicativo ABERTO, e quando a tela de notificações era visitada.
        Quem abrisse o aplicativo encerrado — com ou sem toque num aviso — via
        o sino em zero, mesmo com avisos não lidos esperando no servidor. Foi o
        que o piloto físico encontrou.

        O gatilho é a fase da sessão porque a pergunta não é sobre push: é
        "existe alguém autenticado aqui?". Isso vale para o cold start com
        toque, para o cold start sem toque nenhum e para o login comum, com uma
        regra só — e não deixa o sino depender de um callback do Firebase, que
        num aparelho sem Google Play nunca chega.

        `authenticated` acontece depois do `/me`, então o token já está no
        cofre e a leitura sai autenticada.
      */
      final notificacoes = ref.read(notificationsControllerProvider.notifier);
      if (fase == SessionPhase.authenticated) {
        notificacoes.load();
      } else if (fase == SessionPhase.unauthenticated ||
          fase == SessionPhase.revoked) {
        // A sessão acabou. O que era dela não pode aparecer para a próxima.
        notificacoes.clear();
      }
    });

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
