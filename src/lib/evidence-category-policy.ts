import type { EvidenceCategory } from "@prisma/client";

/**
 * As categorias de foto que uma CONFIGURAÇÃO pode exigir.
 *
 * É o enum `EvidenceCategory` do Prisma **menos `EQUIPMENT_LABEL`**, e a
 * exclusão é deliberada: a etiqueta não é uma foto que o técnico tira quando
 * decide. Ela nasce `TEMPORARY`, é promovida a `COMMITTED` pelo registro do
 * equipamento que ela identifica e volta a temporária quando esse equipamento
 * é removido (v0.10.1). Exigi-la como categoria de conclusão seria pedir ao
 * técnico algo que ele não controla sozinho — e a exigência de equipamento,
 * que é o fato real por trás dela, já existe em `requireEquipment`.
 *
 * ## Por que esta lista mora aqui, e não em cada consumidor
 *
 * Ela existia COPIADA em três lugares — a rota da política, a rota do
 * checklist e a tela de `/tipos-os` —, e três cópias da mesma regra são três
 * chances de divergir. A que divergisse seria a que ninguém revisou: uma
 * categoria oferecida pela tela e recusada pelo servidor vira um `400` que o
 * operador lê como defeito.
 *
 * O módulo é de CLIENTE também: só `import type` do Prisma, nada que alcance
 * o banco. É o que permite a tela consumi-lo sem arrastar o Prisma para o
 * bundle do navegador (a armadilha que a `DQ-4` e a `CTO-3.2.1b` já pagaram).
 *
 * O `satisfies` é a guarda que importa: um valor escrito errado aqui não
 * compila, em vez de virar uma opção que o banco recusa em tempo de execução.
 */
export const POLICY_EVIDENCE_CATEGORIES = [
  "BEFORE_SERVICE",
  "INSTALLATION_LOCATION",
  "CABLE_ROUTE",
  "CTO",
  "ONU_ONT",
  "ROUTER",
  "EQUIPMENT",
  "OPTICAL_READING",
  "WIFI_TEST",
  "SPEED_TEST",
  "AFTER_SERVICE",
  "OTHER",
] as const satisfies readonly EvidenceCategory[];

/** Uma categoria que a configuração aceita. Subconjunto de `EvidenceCategory`. */
export type PolicyEvidenceCategory = (typeof POLICY_EVIDENCE_CATEGORIES)[number];

/**
 * Teto do mínimo de fotos que um tipo de OS pode exigir.
 *
 * É o teto de fotos por OS do fechamento: exigir mais do que cabe seria
 * configurar uma OS que ninguém consegue concluir.
 *
 * Mora aqui, e não em `service-order-completion.ts`, porque a TELA precisa
 * dele para limitar o campo — e aquele módulo alcança o Prisma, que não entra
 * no bundle do navegador. `service-order-completion.ts` o reexporta, então
 * nenhum consumidor de servidor mudou de import.
 */
export const MAX_REQUIRED_EVIDENCE = 10;

/** `true` quando o valor é uma categoria configurável. */
export function isPolicyEvidenceCategory(
  value: string,
): value is PolicyEvidenceCategory {
  return (POLICY_EVIDENCE_CATEGORIES as readonly string[]).includes(value);
}
