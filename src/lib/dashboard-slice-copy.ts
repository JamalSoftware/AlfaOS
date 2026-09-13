/**
 * # O texto de cada recorte do painel — num lugar só (DASH-1a)
 *
 * Um recorte aparece em três lugares: no cartão do painel, na faixa da
 * listagem ("Recorte do painel: …") e no estado vazio da listagem. Com o texto
 * espalhado, o cartão diria "OS pendentes" e a faixa "Pendentes", e o estado
 * vazio sugeriria "sincronize o Mock ERP" a quem só queria saber que não há OS
 * de hoje. As chaves são as MESMAS dos cartões (`dashboard-cards.ts`).
 *
 * O estado vazio de um recorte diz que **não há item neste recorte** — e não
 * sugere ação: um recorte vazio é uma boa notícia ou um fato, nunca um erro.
 */

export const DASHBOARD_SLICE_KEYS = [
  "abertas",
  "atrasadas",
  "hoje",
  "pendentes",
  "tecnicos-em-atendimento",
  "clientes-offline",
  "ctos-com-defeito",
  "ctos-com-os-abertas",
] as const;

export type DashboardSliceKey = (typeof DASHBOARD_SLICE_KEYS)[number];

export interface DashboardSliceCopy {
  /** O nome do recorte — o mesmo no cartão e na faixa. */
  label: string;
  /** O item contado, no singular e no plural: "1 OS", "2 técnicos". */
  singular: string;
  plural: string;
  emptyTitle: string;
  emptyDescription: string;
}

export const DASHBOARD_SLICE_COPY: Record<DashboardSliceKey, DashboardSliceCopy> = {
  abertas: {
    label: "OS abertas",
    singular: "OS",
    plural: "OS",
    emptyTitle: "Nenhuma OS aberta",
    emptyDescription: "Não há ordens de serviço abertas neste momento.",
  },
  atrasadas: {
    label: "OS atrasadas",
    singular: "OS",
    plural: "OS",
    emptyTitle: "Nenhuma OS atrasada",
    emptyDescription:
      "Nenhuma ordem com horário agendado vencido está aguardando o início do atendimento.",
  },
  hoje: {
    label: "OS de hoje",
    singular: "OS",
    plural: "OS",
    emptyTitle: "Nenhuma OS agendada para hoje",
    emptyDescription: "Não há ordens abertas agendadas para o dia de hoje.",
  },
  pendentes: {
    label: "OS pendentes",
    singular: "OS",
    plural: "OS",
    emptyTitle: "Nenhuma OS pendente",
    emptyDescription: "Todas as ordens abertas já têm técnico atribuído.",
  },
  "tecnicos-em-atendimento": {
    label: "Técnicos em atendimento",
    singular: "técnico",
    plural: "técnicos",
    emptyTitle: "Nenhum técnico em atendimento",
    emptyDescription: "Nenhum técnico está com OS em atendimento neste momento.",
  },
  "clientes-offline": {
    label: "Clientes offline",
    singular: "cliente",
    plural: "clientes",
    emptyTitle: "Nenhum cliente offline",
    emptyDescription:
      "Nenhum cliente ativo tem a última leitura de conectividade como offline.",
  },
  "ctos-com-defeito": {
    label: "CTOs com defeito",
    singular: "CTO",
    plural: "CTOs",
    emptyTitle: "Nenhuma CTO com defeito",
    emptyDescription: "Nenhuma caixa ativa tem porta danificada.",
  },
  "ctos-com-os-abertas": {
    label: "CTOs com OS abertas",
    singular: "CTO",
    plural: "CTOs",
    emptyTitle: "Nenhuma CTO com OS abertas",
    emptyDescription:
      "Nenhum cliente vinculado a uma caixa tem ordem de serviço aberta.",
  },
};

/**
 * O substantivo que acompanha o número — "1 OS", "2 técnicos", "1 CTO", nunca
 * "1 clientes". Singular só para exatamente 1: "0 clientes", não "0 cliente".
 */
export function nounFor(
  total: number,
  copy: Pick<DashboardSliceCopy, "singular" | "plural">,
): string {
  return total === 1 ? copy.singular : copy.plural;
}

/**
 * O estado vazio de uma listagem com recorte.
 *
 * Sem outros filtros, o vazio é do RECORTE — "Nenhuma OS agendada para hoje" é
 * um fato sobre o dia. Com filtros somados ao recorte, afirmar isso seria
 * falso: pode haver OS de hoje, e foi a busca que as tirou da tela. Nesse caso
 * a mensagem diz que a combinação não tem resultado, e a única ação sugerida é
 * a que resolve — ajustar os filtros.
 */
export function sliceEmptyState(
  key: DashboardSliceKey,
  hasOtherFilters: boolean,
): { title: string; description: string } {
  const copy = DASHBOARD_SLICE_COPY[key];
  if (!hasOtherFilters) {
    return { title: copy.emptyTitle, description: copy.emptyDescription };
  }
  return {
    title: "Nenhum resultado com estes filtros",
    description: `O recorte "${copy.label}" continua aplicado. Ajuste ou limpe os filtros para ver todos os itens dele.`,
  };
}
