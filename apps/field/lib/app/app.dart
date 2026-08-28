import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

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
      ref.read(sessionControllerProvider.notifier).bootstrap();
    });
  }

  @override
  Widget build(BuildContext context) {
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
