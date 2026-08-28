import 'dart:developer' as developer;

import '../config/env.dart';

/// Log do aplicativo — silencioso em release, redigido em debug.
///
/// Existe para que nenhuma tela precise de `print`. Um `print` espalhado é
/// como um token vaza: alguém depura uma requisição, imprime o mapa inteiro de
/// headers, e o `Authorization` fica no logcat de um aparelho que qualquer
/// pessoa com um cabo consegue ler.
///
/// A redação é feita AQUI, no único ponto de saída, e não na chamada. Confiar
/// em quem escreve o log para lembrar de mascarar garante que um dia alguém
/// esqueça.
class Log {
  const Log._();

  /// Chaves cujo VALOR nunca é impresso, em qualquer profundidade.
  static const _redactedKeys = <String>{
    'authorization',
    'token',
    'accesstoken',
    'bearer',
    'password',
    'senha',
    'pushtoken',
    'tokenhash',
    'installationid',
    // Telefone e endereço não são segredo, mas são dado pessoal e não têm
    // utilidade nenhuma num log de desenvolvimento.
    'phone',
    'secondaryphone',
    'address',
    'document',
  };

  static const _mask = '[REDACTED]';

  /// Substitui valores sensíveis, preservando a forma do objeto.
  ///
  /// Devolve a ESTRUTURA para que o log continue útil — saber que veio uma
  /// lista de 12 itens com os campos certos é o que ajuda a depurar; o
  /// conteúdo de cada um raramente é.
  static Object? redact(Object? value) {
    if (value is Map) {
      return value.map((key, dynamic v) {
        final normalized = key.toString().toLowerCase().replaceAll('_', '');
        if (_redactedKeys.contains(normalized)) {
          return MapEntry(key.toString(), _mask);
        }
        return MapEntry(key.toString(), redact(v));
      });
    }
    if (value is Iterable) {
      return value.map(redact).toList();
    }
    return value;
  }

  static void debug(String message, {Object? data}) {
    if (!Env.isDebug) return;
    final suffix = data == null ? '' : ' ${redact(data)}';
    developer.log('$message$suffix', name: 'alfaos.field');
  }

  /// Falha. Em release não escreve nada; o ponto de extensão para um serviço
  /// de crash reporting futuro é aqui, e não espalhado pelo código.
  static void error(String message, {Object? error}) {
    if (!Env.isDebug) return;
    developer.log(
      message,
      name: 'alfaos.field',
      // `error.toString()` de propósito: o objeto inteiro poderia arrastar a
      // requisição — com headers — para dentro do log.
      error: error?.toString(),
    );
  }
}
