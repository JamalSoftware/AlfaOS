import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// # O que a captura NÃO pode fazer — por inspeção do código (RC-1C-HOTFIX)
///
/// Duas regras que teste de comportamento não alcança, porque moram na
/// fronteira com o plugin — que nenhum teste de unidade executa:
///
/// 1. **Nenhuma posição guardada.** `getLastKnownPosition` devolve o que o
///    sistema tinha em cache, de qualquer idade e de qualquer provedor. Não
///    existe uso legítimo dele em Confirmar ou Corrigir, e o aplicativo não
///    tem outro — a proibição vale para `lib/` inteiro.
/// 2. **Nenhuma coordenada em log.** O motivo da falha e a melhor precisão
///    bastam para diagnosticar; a posição do técnico não tem lugar num log.
///
/// Os comentários saem antes de olhar: o próprio texto que explica a regra
/// cita o nome proibido.

/// Sem comentários e com fim de linha `\n` — o checkout no Windows é CRLF.
String _semComentarios(String fonte) => fonte
    .replaceAll('\r\n', '\n')
    .replaceAll(RegExp(r'/\*.*?\*/', dotAll: true), '')
    .replaceAll(RegExp(r'//[^\n]*'), '');

Iterable<File> _dart(String raiz) =>
    Directory(raiz)
        .listSync(recursive: true)
        .whereType<File>()
        .where((f) => f.path.endsWith('.dart'));

void main() {
  test('nenhum código do aplicativo usa a última posição conhecida', () {
    final usos = <String>[];
    for (final f in _dart('lib')) {
      if (_semComentarios(f.readAsStringSync())
          .contains('getLastKnownPosition')) {
        usos.add(f.path.replaceAll(r'\', '/'));
      }
    }
    expect(usos, isEmpty);
  });

  test('confirmar e corrigir não leem o GPS do check-in', () {
    // O check-in aceita a leitura que vier; Confirmar e Corrigir só a da
    // captura. Uma chamada a `_readPosition`/`_location` fora do check-in
    // seria o caminho antigo de volta.
    final fonte = _semComentarios(
      File('lib/features/execution/state/execution_controller.dart')
          .readAsStringSync(),
    );
    final leituras = RegExp(r'_readPosition\(\)|_location\.current\(\)')
        .allMatches(fonte)
        .length;
    // A declaração de `_readPosition`, a leitura dentro dela e a chamada do
    // check-in — e só.
    expect(leituras, 3);
    for (final metodo in ['confirmLocation', 'correctLocation']) {
      final inicio = fonte.indexOf('Future<bool> $metodo(');
      expect(inicio, isNonNegative, reason: '$metodo sumiu');
      final fim = fonte.indexOf('\n  }\n', inicio);
      final corpo = fonte.substring(inicio, fim);
      expect(corpo, isNot(contains('_readPosition')), reason: metodo);
      expect(corpo, isNot(contains('_location')), reason: metodo);
    }
  });

  test('nenhum log da localização carrega coordenada', () {
    for (final caminho in [
      'lib/core/location/operational_position.dart',
      'lib/core/location/location_service.dart',
    ]) {
      final fonte = _semComentarios(File(caminho).readAsStringSync());
      for (final chamada in RegExp(
        r'Log\.(debug|error)\((.*?)\);',
        dotAll: true,
      ).allMatches(fonte)) {
        final argumentos = chamada.group(2)!;
        expect(
          argumentos,
          isNot(matches(RegExp('latitude|longitude|leitura|fix|position'))),
          reason: '$caminho: ${argumentos.trim()}',
        );
      }
    }
  });
}
