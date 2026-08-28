import 'dart:convert';
import 'dart:typed_data';

import 'package:alfaos_field/core/api/field_api_client.dart';
import 'package:alfaos_field/core/storage/session_store.dart';
import 'package:dio/dio.dart';

/// Transporte falso: responde sem rede.
///
/// Implementa o `HttpClientAdapter` do Dio em vez de simular o repositório.
/// A diferença importa: assim o teste exercita o cliente REAL — headers,
/// timeouts, envelope, tradução de erro —, e não uma reimplementação dele que
/// poderia divergir sem ninguém perceber.
class FakeTransport implements HttpClientAdapter {
  FakeTransport();

  /// Respostas por `MÉTODO caminho`, ex.: `POST /auth/login`.
  final Map<String, FakeReply> replies = {};

  /// Tudo que passou por aqui. É o que permite afirmar o que o app REALMENTE
  /// enviou — inclusive os headers.
  final List<RequestOptions> requests = [];

  /// Quando true, toda chamada falha como se não houvesse rede.
  bool offline = false;

  void on(String method, String path, FakeReply reply) {
    replies['$method $path'] = reply;
  }

  void onJson(
    String method,
    String path, {
    int status = 200,
    Map<String, dynamic> data = const {},
  }) {
    on(
      method,
      path,
      FakeReply(status: status, body: {'ok': true, 'data': data}),
    );
  }

  void onError(
    String method,
    String path, {
    required int status,
    required String code,
    String message = 'erro',
    bool retryable = false,
    bool conflict = false,
  }) {
    on(
      method,
      path,
      FakeReply(
        status: status,
        body: {
          'ok': false,
          'error': {
            'code': code,
            'message': message,
            'retryable': retryable,
            'conflict': conflict,
          },
        },
      ),
    );
  }

  RequestOptions requestFor(String method, String path) => requests.firstWhere(
    (r) => r.method == method && r.path == path,
    orElse: () => throw StateError('nenhuma requisição $method $path'),
  );

  int countOf(String method, String path) =>
      requests.where((r) => r.method == method && r.path == path).length;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);

    /*
      Drena o corpo quando ele é um STREAM.

      Multipart (foto de evidência, assinatura) chega como `requestStream`. Um
      adaptador que o ignora deixa o Dio esperando o envio terminar para
      sempre: o teste não falha com erro, ele PENDURA — foi assim que o teste de
      reenvio de foto estourou o `pumpAndSettle` sem dizer por quê.
    */
    if (requestStream != null) {
      await requestStream.drain<void>();
    }

    if (offline) {
      throw DioException.connectionError(
        requestOptions: options,
        reason: 'transporte falso offline',
      );
    }

    final reply = replies['${options.method} ${options.path}'];
    if (reply == null) {
      return ResponseBody.fromString(
        jsonEncode({
          'ok': false,
          'error': {'code': 'NOT_FOUND', 'message': 'sem rota falsa'},
        }),
        404,
        headers: {
          Headers.contentTypeHeader: [Headers.jsonContentType],
        },
      );
    }

    return ResponseBody.fromString(
      jsonEncode(reply.body),
      reply.status,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

class FakeReply {
  const FakeReply({required this.status, required this.body});

  final int status;
  final Map<String, dynamic> body;
}

/// Armazenamento em memória, com o MESMO contrato do real.
///
/// Guarda token e `installationId` em campos separados de propósito: é o que
/// permite um teste afirmar que o token nunca encostou no lugar não seguro.
class FakeSessionStore implements SessionStore {
  String? token;
  String? installation;

  /// Tudo que passou pelo armazenamento NÃO seguro. Um teste verifica que o
  /// token jamais aparece aqui.
  final Map<String, String> insecureWrites = {};

  @override
  Future<String?> readToken() async => token;

  @override
  Future<void> writeToken(String value) async => token = value;

  @override
  Future<void> clear() async => token = null;

  @override
  Future<String> installationId() async {
    final existing = installation;
    if (existing != null) return existing;
    final created = 'installation-de-teste-0001';
    installation = created;
    insecureWrites['installationId'] = created;
    return created;
  }
}

/// Cliente pronto para teste, ligado ao transporte falso.
({FieldApiClient client, FakeTransport transport, FakeSessionStore store})
buildTestClient({void Function()? onSessionEnded}) {
  final transport = FakeTransport();
  final store = FakeSessionStore();
  return (
    client: buildTestClientWith(
      transport,
      store,
      onSessionEnded: onSessionEnded,
    ),
    transport: transport,
    store: store,
  );
}

/// Mesma montagem, com transporte e armazenamento já existentes.
FieldApiClient buildTestClientWith(
  FakeTransport transport,
  FakeSessionStore store, {
  void Function()? onSessionEnded,
}) {
  final dio = Dio()..httpClientAdapter = transport;
  return FieldApiClient(
    dio: dio,
    tokenProvider: store.readToken,
    onSessionEnded: () async {
      await store.clear();
      onSessionEnded?.call();
    },
  );
}
