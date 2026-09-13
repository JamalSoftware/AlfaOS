import Link from "next/link";
import {
  DASHBOARD_SLICE_COPY,
  nounFor,
  type DashboardSliceKey,
} from "@/lib/dashboard-slice-copy";

/**
 * A faixa que a listagem mostra quando chega por um cartão do painel (DASH-1).
 *
 * Diz QUAL recorte está aplicado e QUANTOS itens ele tem — o mesmo número do
 * cartão de onde a pessoa veio, por construção. Sem ela, um filtro que só
 * existe na URL seria invisível: a lista pareceria incompleta, e ninguém
 * saberia por quê nem como sair dela.
 *
 * O texto vem de `DASHBOARD_SLICE_COPY` pela chave do cartão (DASH-1a): o nome
 * na faixa é o nome no cartão, nas oito listagens, e o singular/plural também.
 */
export function ListSliceBanner({
  sliceKey,
  total,
  clearHref,
}: {
  sliceKey: DashboardSliceKey;
  total: number;
  clearHref: string;
}) {
  const copy = DASHBOARD_SLICE_COPY[sliceKey];
  return (
    <div
      data-testid="list-slice-banner"
      data-slice-key={sliceKey}
      className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-info-border bg-info-bg px-4 py-2.5 text-sm"
    >
      <p className="text-fg">
        <span className="text-fg-secondary">Recorte do painel:</span>{" "}
        <span className="font-semibold">{copy.label}</span>
        <span className="text-fg-secondary">
          {" · "}
          <span data-testid="list-slice-total" className="font-semibold tabular-nums text-fg">
            {total}
          </span>{" "}
          {nounFor(total, copy)}
        </span>
      </p>
      <Link
        href={clearHref}
        data-testid="list-slice-clear"
        className="font-semibold text-primary-text hover:text-primary-text-hover"
      >
        Limpar recorte
      </Link>
    </div>
  );
}
