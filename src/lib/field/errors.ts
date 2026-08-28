import { DomainError } from "@/lib/errors";

/**
 * Contrato de erro do Field.
 *
 * A API da web devolve `{ ok: false, error: "mensagem em português" }`, e para
 * um navegador isso basta: quem lê é gente, e a tela mostra o texto.
 *
 * O Flutter não pode fazer isso. Um aplicativo que decide entre "tentar de
 * novo", "atualizar e mostrar conflito" e "mandar o técnico fazer login" lendo
 * a mensagem humana quebra na primeira vez que alguém corrige uma vírgula — e
 * quebra num APK que já está em campo, meses depois, sem como corrigir. Por
 * isso o desfecho vem em `code`, estável e fechado, e a mensagem é só para
 * exibir.
 *
 * `retryable` e `conflict` são derivados do código, nunca escritos à mão na
 * rota: são justamente as duas decisões que o app precisa tomar, e deixá-las
 * a cargo de quem escreve cada endpoint garantiria que um dia divergissem.
 */
export const FIELD_ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "VALIDATION_ERROR",
  "UPSTREAM_UNAVAILABLE",
  "IDEMPOTENCY_CONFLICT",
  /**
   * Este aparelho foi revogado por um administrador.
   *
   * Código PRÓPRIO, e não `UNAUTHENTICATED`, por uma razão prática: é a única
   * recusa cuja saída não é "faça login de novo". Tentar de novo com a mesma
   * instalação nunca vai funcionar, e o aplicativo precisa dizer isso à pessoa
   * — que deve falar com a empresa — em vez de deixá-la digitando a senha.
   *
   * Devolvido apenas a quem já provou a credencial correta, então não conta
   * nada a um desconhecido: quem erra a senha continua recebendo o
   * `UNAUTHENTICATED` uniforme.
   */
  "DEVICE_REVOKED",

  /**
   * A foto da etiqueta passou do prazo e não serve mais para criar equipamento.
   *
   * Código PRÓPRIO pelo mesmo motivo de `DEVICE_REVOKED`: é a única recusa de
   * validação cuja saída não é "corrija o formulário". Tentar de novo com a
   * mesma foto nunca vai funcionar — o aplicativo precisa pedir uma nova
   * captura, e distinguir isso por texto de mensagem seria frágil.
   *
   * Um APK que não conheça o código cai em `unknown` e mostra a mensagem do
   * servidor, que já explica o que fazer.
   */
  "LABEL_EXPIRED",
  "INTERNAL",
] as const;

export type FieldErrorCode = (typeof FIELD_ERROR_CODES)[number];

export interface FieldErrorBody {
  code: FieldErrorCode;
  message: string;
  /**
   * A MESMA requisição, reenviada mais tarde, pode dar certo?
   *
   * Só para falha transitória. Um 404 ou um 403 não viram sucesso por
   * insistência, e marcá-los como retryable ensinaria o aplicativo a martelar
   * o servidor com uma requisição que nunca vai passar.
   */
  retryable: boolean;
  /**
   * O estado no servidor divergiu do que o aparelho tinha.
   *
   * É o sinal para o app recarregar e mostrar o conflito a uma pessoa, em vez
   * de reenviar. Nunca "last write wins" silencioso para decisão operacional
   * (PRD §161).
   */
  conflict: boolean;
}

const STATUS_BY_CODE: Record<FieldErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  VALIDATION_ERROR: 400,
  UPSTREAM_UNAVAILABLE: 503,
  IDEMPOTENCY_CONFLICT: 409,
  DEVICE_REVOKED: 403,
  // 400 e não 409: nada mudou debaixo do aparelho — o prazo simplesmente
  // passou. `conflict` faria o Flutter recarregar o pacote, que não é a saída.
  LABEL_EXPIRED: 400,
  INTERNAL: 500,
};

/** Transitório: esperar e repetir tem chance real de funcionar. */
const RETRYABLE: ReadonlySet<FieldErrorCode> = new Set<FieldErrorCode>([
  "RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE",
  "INTERNAL",
]);

/** O servidor mudou debaixo do aparelho; reenviar igual não resolve. */
const CONFLICTING: ReadonlySet<FieldErrorCode> = new Set<FieldErrorCode>([
  "CONFLICT",
  "IDEMPOTENCY_CONFLICT",
]);

export function fieldErrorStatus(code: FieldErrorCode): number {
  return STATUS_BY_CODE[code];
}

export function fieldErrorBody(
  code: FieldErrorCode,
  message: string,
): FieldErrorBody {
  return {
    code,
    message,
    retryable: RETRYABLE.has(code),
    conflict: CONFLICTING.has(code),
  };
}

/**
 * Erro do Field com código explícito.
 *
 * Estende `DomainError` de propósito: o `runApi` da web já sabe traduzir
 * `DomainError` em HTTP, então um serviço compartilhado que lance isto
 * continua funcionando para os dois clientes. O que o Field acrescenta é o
 * `code`, que a web ignora.
 */
export class FieldError extends DomainError {
  readonly code: FieldErrorCode;

  constructor(code: FieldErrorCode, message: string) {
    super(fieldErrorStatus(code), message);
    this.name = "FieldError";
    this.code = code;
  }
}

/**
 * Traduz o status de um `DomainError` do domínio compartilhado em código Field.
 *
 * Existe porque os serviços de domínio (`startServiceOrder`,
 * `revealConnectionPasswordForOrder`, …) são os MESMOS para web e Field, e
 * lançam `DomainError` com status HTTP. Duplicá-los só para trocar o formato
 * do erro criaria duas regras de negócio — exatamente o que a §3 proíbe.
 */
export function fieldCodeForStatus(status: number): FieldErrorCode {
  switch (status) {
    case 400:
      return "VALIDATION_ERROR";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 429:
      return "RATE_LIMITED";
    case 503:
      return "UPSTREAM_UNAVAILABLE";
    default:
      return "INTERNAL";
  }
}
