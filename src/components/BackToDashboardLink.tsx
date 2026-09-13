import Link from "next/link";

/**
 * "← Voltar ao Dashboard" — a volta de uma listagem aberta por um cartão do
 * painel (DASH-1a).
 *
 * **Destino fixo, `/dashboard`, e nunca `router.back()`.** "A página anterior
 * do navegador" não é a mesma pergunta que "de onde este fluxo veio": depois
 * de filtrar, paginar ou recarregar, o histórico aponta para a própria
 * listagem, e um link colado não tem histórico nenhum. O mapa já pagou por essa
 * lição (`CTO-3.2.1`); aqui a origem é conhecida e é uma só.
 *
 * Não é "Limpar recorte": aquele fica na listagem e tira o recorte; este sai
 * dela. As duas ações existem juntas e nenhuma substitui a outra.
 */
export function BackToDashboardLink() {
  return (
    <Link
      href="/dashboard"
      data-testid="back-to-dashboard"
      className="mb-1 inline-flex min-h-[1.75rem] items-center gap-1 rounded text-sm font-semibold text-primary-text hover:text-primary-text-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <span aria-hidden="true">←</span>
      Voltar ao Dashboard
    </Link>
  );
}
