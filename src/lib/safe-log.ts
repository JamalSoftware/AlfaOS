/**
 * Log de erro de servidor que não carrega dado (RC-LOG-01).
 *
 * ## Por que a mensagem nunca é impressa
 *
 * Mensagem de erro é texto livre de quem o lançou, e três fontes comuns põem
 * dado nela:
 *
 * - o Prisma, que em `PrismaClientValidationError` repete os ARGUMENTOS da
 *   consulta — nome, documento, o `details` de auditoria que ia ser gravado;
 * - o filesystem, que põe o caminho absoluto, com a chave de storage;
 * - qualquer `throw new Error(\`...${valor}\`)` escrito às pressas.
 *
 * Log de produção costuma sair da máquina (agregador, ticket, print numa
 * conversa), então o que entra nele tem de ser seguro por construção — não por
 * disciplina de quem escreve o `throw`.
 *
 * ## O que é impresso
 *
 * O tipo do erro, um código de formato conhecido (Prisma `P####` ou errno
 * `E*`) e o contexto que o CHAMADOR escolheu. O contexto também é filtrado:
 * só aceita valor com cara de identificador ou código — texto com espaço ou
 * pontuação livre vira `?`, para que um nome de cliente passado ali por engano
 * não atravesse.
 *
 * Em desenvolvimento entra também a pilha, mas só as linhas de frame
 * (`at arquivo:linha:coluna`): a pilha começa pela mensagem, e ela fica de
 * fora aqui também. Nos outros ambientes, nem os frames.
 *
 * O padrão é o que `dashboard`, `global-search`, `customer-timeline` e o pacote
 * técnico já usavam (só `error.name`); aqui ele fica num lugar só.
 */

export type LogContext = Record<string, string | number | boolean | null | undefined>;

export interface SafeErrorSummary {
  erro: string;
  codigo?: string;
}

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;
const PRISMA_CODE = /^P\d{4}$/;
const ERRNO_CODE = /^E[A-Z0-9_]{2,30}$/;
const SAFE_VALUE = /^[A-Za-z0-9_.:@\-]{1,80}$/;
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,30}$/;
const FRAME = /^at (?:async )?\S.*:\d+:\d+\)?$/;
const MAX_FRAMES = 8;

export function summarizeError(error: unknown): SafeErrorSummary {
  if (!(error instanceof Error)) {
    return { erro: "desconhecido" };
  }
  const summary: SafeErrorSummary = {
    erro: SAFE_NAME.test(error.name) ? error.name : "Error",
  };
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && (PRISMA_CODE.test(code) || ERRNO_CODE.test(code))) {
    summary.codigo = code;
  }
  return summary;
}

function contextValue(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return SAFE_VALUE.test(value) ? value : "?";
}

function stackFrames(error: unknown): string[] {
  if (!(error instanceof Error) || typeof error.stack !== "string") {
    return [];
  }
  return error.stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => FRAME.test(line))
    .slice(0, MAX_FRAMES);
}

/**
 * Uma linha: `[escopo] chave=valor … erro=Tipo codigo=P2002`.
 *
 * Uma string, e não um objeto, porque é o que qualquer coletor de log lê igual
 * — e é o formato dos logs estruturados que já existem (`[diagnostics]
 * provider=… outcome=…`).
 */
export function logServerError(
  scope: string,
  error: unknown,
  context: LogContext = {},
): void {
  const partes = Object.entries(context)
    .filter(([key]) => SAFE_KEY.test(key))
    .map(([key, value]) => `${key}=${contextValue(value)}`);
  const resumo = summarizeError(error);
  partes.push(`erro=${resumo.erro}`);
  if (resumo.codigo) partes.push(`codigo=${resumo.codigo}`);

  let linha = `[${scope}] ${partes.join(" ")}`;
  if (process.env.NODE_ENV === "development") {
    const frames = stackFrames(error);
    if (frames.length > 0) {
      linha += `\n    ${frames.join("\n    ")}`;
    }
  }
  console.error(linha);
}
