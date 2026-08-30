import 'package:dio/dio.dart';

import '../config/env.dart';
import '../errors/field_error.dart';
import '../logging/log.dart';

/// Cliente único da Field API.
///
/// Nenhuma tela fala HTTP. Aqui ficam, num lugar só: a URL base, o header de
/// autenticação, os timeouts, a tradução do contrato de erro e a redação do
/// log. Espalhar isso significaria que um dia uma tela nova esqueceria um dos
/// cinco — e o que ela esqueceria seria o Bearer ou a redação.
class FieldApiClient {
  FieldApiClient({
    Dio? dio,
    required Future<String?> Function() tokenProvider,
    Future<void> Function()? onSessionEnded,
  }) : _tokenProvider = tokenProvider,
       _onSessionEnded = onSessionEnded,
       _dio = dio ?? Dio() {
    _dio.options = _dio.options.copyWith(
      baseUrl: Env.apiRoot,
      // Timeouts explícitos. Sem eles o Dio espera indefinidamente, e uma rede
      // ruim — que é a rede do técnico — vira uma tela travada sem saída.
      connectTimeout: const Duration(seconds: 10),
      sendTimeout: const Duration(seconds: 20),
      receiveTimeout: const Duration(seconds: 20),
      // O cliente trata todo status; a validação do Dio só atrapalharia.
      validateStatus: (_) => true,
      responseType: ResponseType.json,
      headers: const {'Accept': 'application/json'},
    );
  }

  final Dio _dio;
  final Future<String?> Function() _tokenProvider;
  final Future<void> Function()? _onSessionEnded;

  Dio get raw => _dio;

  Future<Map<String, dynamic>> get(
    String path, {
    Map<String, dynamic>? query,
    bool authenticated = true,
  }) => _send(
    () async => _dio.get<dynamic>(
      path,
      queryParameters: query,
      options: await _options(authenticated),
    ),
    path,
    authenticated: authenticated,
  );

  Future<Map<String, dynamic>> post(
    String path, {
    Object? body,
    bool authenticated = true,

    /// Chave de idempotência. Obrigatória nos comandos mutantes do contrato.
    String? idempotencyKey,
  }) => _send(
    () async => _dio.post<dynamic>(
      path,
      data: body,
      options: await _options(authenticated, idempotencyKey: idempotencyKey),
    ),
    path,
    authenticated: authenticated,
  );

  /// Envio de arquivo — foto de evidência e assinatura.
  ///
  /// `multipart`, não JSON com base64: base64 infla 33% e obrigaria a carregar
  /// a imagem inteira como string na memória do aparelho, que é justamente o
  /// recurso escasso num celular de campo com uma foto de 8 MB.
  ///
  /// O timeout de envio é maior que o padrão porque a rede do técnico é a pior
  /// do sistema: 20 segundos derrubariam um upload legítimo em borda de sinal,
  /// e o técnico repetiria a foto achando que falhou.
  Future<Map<String, dynamic>> upload(
    String path, {
    required FormData form,
    required String idempotencyKey,
    String method = 'POST',
  }) => _send(
    () async => _dio.request<dynamic>(
      path,
      data: form,
      options: (await _options(true, idempotencyKey: idempotencyKey)).copyWith(
        method: method,
        sendTimeout: const Duration(minutes: 2),
        receiveTimeout: const Duration(minutes: 2),
      ),
    ),
    path,
  );

  Future<Options> _options(bool authenticated, {String? idempotencyKey}) async {
    final headers = <String, String>{};
    if (authenticated) {
      final token = await _tokenProvider();
      if (token != null && token.isNotEmpty) {
        // SOMENTE aqui. Nunca em query string — a URL entra em log de
        // servidor, histórico e Referer.
        headers['Authorization'] = 'Bearer $token';
      }
    }
    if (idempotencyKey != null) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    return Options(headers: headers);
  }

  Future<Map<String, dynamic>> _send(
    Future<Response<dynamic>> Function() call,
    String path, {

    /// A requisição levava credencial?
    ///
    /// Só o que levava pode ter a sessão encerrada por um 401. O login não
    /// leva — e tratar a recusa dele como "sua sessão expirou" diria a frase
    /// errada a quem apenas errou a senha.
    bool authenticated = true,
  }) async {
    Response<dynamic> response;
    try {
      response = await call();
    } on DioException catch (error) {
      Log.error('falha de rede em $path', error: error.type);
      /*
        Timeout e ausência de rede são desfechos diferentes PARA QUEM LÊ.

        O app trata os dois igual — ambos retentáveis, mesmo código —, mas a
        frase muda: mandar checar o sinal alguém que está com sinal cheio e um
        servidor lento é mandar procurar o problema no lugar errado.
      */
      const lentos = {
        DioExceptionType.connectionTimeout,
        DioExceptionType.sendTimeout,
        DioExceptionType.receiveTimeout,
      };
      throw lentos.contains(error.type)
          ? const FieldException.timeout()
          : const FieldException.network();
    }

    final status = response.statusCode ?? 0;
    final data = response.data;
    Log.debug('$status $path', data: data);

    if (status >= 200 && status < 300) {
      if (data is Map && data['ok'] == true) {
        final payload = data['data'];
        return payload is Map
            ? Map<String, dynamic>.from(payload)
            : <String, dynamic>{};
      }
      // 2xx sem o envelope esperado: contrato quebrado, não sucesso.
      throw const FieldException(
        code: FieldErrorCode.unknown,
        message: 'Resposta inesperada do servidor.',
      );
    }

    throw await _mapError(status, data, signalsSessionEnd: authenticated);
  }

  /// Traduz o corpo de erro do contrato para uma exceção tipada.
  ///
  /// `code` manda; o status HTTP é só complemento. Um APK antigo diante de um
  /// código novo cai em `unknown` e mostra a mensagem do servidor, em vez de
  /// estourar.
  Future<FieldException> _mapError(
    int status,
    dynamic data, {
    bool signalsSessionEnd = true,
  }) async {
    var code = FieldErrorCode.unknown;
    var message = 'Não foi possível concluir a operação.';
    var retryable = status >= 500;
    var conflict = status == 409;
    int? retryAfter;
    var pendencies = const <Map<String, dynamic>>[];

    if (data is Map && data['error'] is Map) {
      final error = Map<String, dynamic>.from(data['error'] as Map);
      code = fieldErrorCodeFrom(error['code'] as String?);
      final raw = error['message'];
      if (raw is String && raw.isNotEmpty) message = raw;
      if (error['retryable'] is bool) retryable = error['retryable'] as bool;
      if (error['conflict'] is bool) conflict = error['conflict'] as bool;
      if (error['retryAfterSeconds'] is int) {
        retryAfter = error['retryAfterSeconds'] as int;
      }
      // Campo ADITIVO (v0.10): só a recusa de conclusão o traz. Um APK antigo
      // simplesmente não o lê e continua mostrando a mensagem.
      final raw2 = error['pendencies'];
      if (raw2 is List) {
        pendencies = raw2
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList(growable: false);
      }
    } else if (status == 401) {
      code = FieldErrorCode.unauthenticated;
    }

    final exception = FieldException(
      code: code,
      message: message,
      retryable: retryable,
      conflict: conflict,
      retryAfterSeconds: retryAfter,
      status: status,
      pendencies: pendencies,
    );

    /*
      Sessão encerrada avisa uma vez, aqui.

      Deixar cada tela reagir a 401 produziria telas que esquecem — e uma delas
      ficaria em laço, reenviando com um token morto. `deviceRevoked` NÃO passa
      por aqui: ele encerra a sessão também, mas a tela é outra, e limpar o
      token esconderia o motivo real de quem precisa lê-lo.
    */
    if (signalsSessionEnd && exception.endsSession && _onSessionEnded != null) {
      await _onSessionEnded();
    }
    return exception;
  }
}
