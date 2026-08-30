/// Catálogo fechado de erros da Field API.
///
/// Espelha `FIELD_ERROR_CODES` do backend (`src/lib/field/errors.ts`). O
/// aplicativo **nunca** lê a mensagem humana para decidir o que fazer: a frase
/// muda quando alguém corrige uma vírgula, e quebraria num APK que já está em
/// campo, meses depois, sem como corrigir.
///
/// `Unknown` existe para o dia em que o backend acrescentar um código: a versão
/// antiga do app cai num desfecho previsível em vez de estourar.
enum FieldErrorCode {
  unauthenticated,
  forbidden,
  notFound,
  conflict,
  rateLimited,
  validationError,
  upstreamUnavailable,
  idempotencyConflict,
  deviceRevoked,

  /// A foto da etiqueta passou do prazo e não serve mais para criar
  /// equipamento. Reenviar o mesmo comando nunca resolve: a saída é uma nova
  /// captura, e por isso o código é próprio em vez de mais um erro de
  /// validação genérico.
  labelExpired,
  internal,

  /// Código que este APK não conhece, ou falha antes de haver resposta.
  unknown,

  /// Não houve resposta: DNS, timeout, socket. Distinto de `internal`, que é
  /// o servidor dizendo que falhou.
  network,
}

FieldErrorCode fieldErrorCodeFrom(String? raw) {
  switch (raw) {
    case 'UNAUTHENTICATED':
      return FieldErrorCode.unauthenticated;
    case 'FORBIDDEN':
      return FieldErrorCode.forbidden;
    case 'NOT_FOUND':
      return FieldErrorCode.notFound;
    case 'CONFLICT':
      return FieldErrorCode.conflict;
    case 'RATE_LIMITED':
      return FieldErrorCode.rateLimited;
    case 'VALIDATION_ERROR':
      return FieldErrorCode.validationError;
    case 'UPSTREAM_UNAVAILABLE':
      return FieldErrorCode.upstreamUnavailable;
    case 'IDEMPOTENCY_CONFLICT':
      return FieldErrorCode.idempotencyConflict;
    case 'LABEL_EXPIRED':
      return FieldErrorCode.labelExpired;
    case 'DEVICE_REVOKED':
      return FieldErrorCode.deviceRevoked;
    case 'INTERNAL':
      return FieldErrorCode.internal;
    default:
      return FieldErrorCode.unknown;
  }
}

/// Falha vinda da Field API, ou da tentativa de alcançá-la.
///
/// ## Estratégia: exceção, não `Either`
///
/// Uma só, e vale para todos os repositórios. Riverpod já modela
/// carregando/erro/dado com `AsyncValue`, e ele captura exceção — então
/// exceção é o que se encaixa sem adaptador. Misturar `Either` num repositório
/// e exceção em outro obrigaria cada tela a saber qual dos dois estilos aquele
/// caso usa, que é exatamente o tipo de detalhe que a UI não deveria carregar.
class FieldException implements Exception {
  const FieldException({
    required this.code,
    required this.message,
    this.retryable = false,
    this.conflict = false,
    this.retryAfterSeconds,
    this.status,
    this.pendencies = const [],
  });

  /// Pendências estruturadas da recusa de conclusão (v0.10).
  ///
  /// Chega apenas em `validationError` vindo de `complete`. Cada entrada tem um
  /// `code` ESTÁVEL — é ele que leva o técnico à seção que falta. A lista é
  /// aditiva ao contrato: um APK que a ignore mostra a mensagem e se comporta
  /// como antes.
  ///
  /// Guardada como mapa cru de propósito: traduzi-la para um tipo do domínio
  /// aqui obrigaria a camada de erro a conhecer o domínio de execução, e um
  /// código novo do servidor viraria exceção de parsing em vez de item
  /// ignorado.
  final List<Map<String, dynamic>> pendencies;

  final FieldErrorCode code;

  /// Texto do servidor. Serve para EXIBIR, nunca para decidir.
  final String message;

  /// A mesma requisição, mais tarde, pode dar certo?
  final bool retryable;

  /// O estado no servidor divergiu do que o aparelho tinha.
  final bool conflict;

  final int? retryAfterSeconds;
  final int? status;

  /// A sessão acabou — token expirado, revogado, ou usuário desativado.
  ///
  /// `deviceRevoked` fica de FORA de propósito: ele também encerra a sessão,
  /// mas exige uma tela diferente. "Entre de novo" é conselho inútil para quem
  /// teve o aparelho bloqueado.
  bool get endsSession => code == FieldErrorCode.unauthenticated;

  const FieldException.network()
    : code = FieldErrorCode.network,
      message = 'Não foi possível conectar ao AlfaOS.',
      retryable = true,
      conflict = false,
      retryAfterSeconds = null,
      status = null,
      pendencies = const [];

  /// O servidor não respondeu a tempo.
  ///
  /// Mesmo `code` de `network`, mensagem diferente — e as duas coisas são
  /// deliberadas. O código é o contrato que o app usa para DECIDIR, e decidir é
  /// igual nos dois casos: dá para tentar de novo. A frase é o que a pessoa lê,
  /// e aí a diferença importa: "sem conexão" manda checar o sinal, enquanto uma
  /// resposta lenta com sinal cheio deixaria alguém procurando um problema de
  /// rede que não existe.
  ///
  /// Um código novo obrigaria o backend a aprender a emiti-lo — e ele nunca
  /// poderia: o timeout acontece justamente quando não houve resposta.
  const FieldException.timeout()
    : code = FieldErrorCode.network,
      message = 'O AlfaOS demorou para responder. Tente de novo.',
      retryable = true,
      conflict = false,
      retryAfterSeconds = null,
      status = null,
      pendencies = const [];

  @override
  String toString() => 'FieldException(${code.name}, status: $status)';
}
