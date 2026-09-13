import {
  CTO_MAP_SEARCH_MAX_QUERY,
  CTO_MAP_SEARCH_MIN_QUERY,
  usefulSearchLength,
} from "./cto-map-presentation";

/**
 * As regras do termo da busca global (GS-1) — módulo PURO.
 *
 * Separado de `global-search.ts` porque o menu lateral é componente de cliente e
 * precisa do teto do campo: importar o domínio arrastaria o Prisma para o
 * bundle do navegador.
 *
 * O mínimo e o máximo são os da busca do mapa (`cto-map-presentation.ts`), para
 * que a mesma pergunta não tenha duas regras: pelo menos dois caracteres ÚTEIS —
 * `%` e `_` não contam, porque o `contains` do Prisma não os escapa e `%%`
 * casaria com tudo — e no máximo sessenta.
 */

/** Quantos resultados por tipo. Decisão técnica: cabe numa tela sem rolar muito. */
export const GLOBAL_SEARCH_PER_TYPE = 5;
export const GLOBAL_SEARCH_MIN_QUERY = CTO_MAP_SEARCH_MIN_QUERY;
export const GLOBAL_SEARCH_MAX_QUERY = CTO_MAP_SEARCH_MAX_QUERY;

export type GlobalSearchQuery =
  | { kind: "empty" }
  | { kind: "too-short"; term: string }
  | { kind: "too-long"; term: string }
  | { kind: "ok"; term: string; orderNumber: number | null; textSearch: boolean };

/**
 * Um número de OS, do jeito que as pessoas escrevem: "12", "#12", "OS 12",
 * "Nº 12". `null` quando o termo não é isso.
 */
export function orderNumberOf(term: string): number | null {
  const m = /^(?:os\s*)?(?:n[ºo°]?\.?\s*)?#?\s*(\d{1,9})$/i.exec(term);
  if (!m) return null;
  const valor = Number(m[1]);
  return Number.isSafeInteger(valor) && valor > 0 ? valor : null;
}

/**
 * O termo, decidido antes de qualquer consulta. A exceção ao mínimo é o número
 * de OS: "7" é uma pergunta completa, e procura só a OS Nº 7.
 */
export function parseGlobalSearchQuery(raw: unknown): GlobalSearchQuery {
  const bruto = Array.isArray(raw) ? raw[0] : raw;
  if (typeof bruto !== "string") return { kind: "empty" };
  const term = bruto.trim();
  if (term === "") return { kind: "empty" };
  if (term.length > GLOBAL_SEARCH_MAX_QUERY) return { kind: "too-long", term };
  const orderNumber = orderNumberOf(term);
  const textSearch = usefulSearchLength(term) >= GLOBAL_SEARCH_MIN_QUERY;
  if (!textSearch && orderNumber === null) return { kind: "too-short", term };
  return { kind: "ok", term, orderNumber, textSearch };
}
