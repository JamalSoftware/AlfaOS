import 'package:flutter/material.dart';

/// A tela que um build MAL CONFIGURADO mostra em vez do aplicativo —
/// `SEC-013`.
///
/// ## Por que uma tela, e não uma exceção
///
/// Lançar em `main` daria um fechamento imediato, sem mensagem: quem instalou
/// o APK veria o aplicativo "abrir e sumir", que é indistinguível de um
/// travamento. Isso viraria um chamado sobre o aparelho em vez de uma correção
/// no build.
///
/// E não pode ser um aviso dispensável: com a URL errada, nada do aplicativo
/// funciona. Deixar entrar produziria "sem conexão" em cada tela, e o técnico
/// levaria a culpa por rede ruim.
///
/// ## O que ela NÃO mostra
///
/// Nada de segredo. A URL da API é configuração de build — ela já viaja em cada
/// requisição — e mostrá-la é justamente o que permite consertar o build sem
/// adivinhação. Token, credencial e dado de cliente não passam por aqui: neste
/// estado o aplicativo nem tentou autenticar.
class MisconfiguredBuildScreen extends StatelessWidget {
  const MisconfiguredBuildScreen({required this.reason, super.key});

  final String reason;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      home: Scaffold(
        body: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.build_circle_outlined, size: 48),
                  const SizedBox(height: 16),
                  const Text(
                    'Build mal configurado',
                    style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    reason,
                    style: const TextStyle(fontSize: 15, height: 1.4),
                  ),
                  const SizedBox(height: 20),
                  const Text(
                    'Este aplicativo não vai funcionar assim. Gere o APK '
                    'novamente informando o endereço do servidor.',
                    style: TextStyle(fontSize: 14, height: 1.4),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
