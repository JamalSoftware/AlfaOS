import Link from "next/link";

/**
 * A faixa que a listagem mostra quando chega por um cartão do painel (DASH-1).
 *
 * Diz QUAL recorte está aplicado e QUANTOS itens ele tem — o mesmo número do
 * cartão de onde a pessoa veio, por construção. Sem ela, um filtro que só
 * existe na URL seria invisível: a lista pareceria incompleta, e ninguém
 * saberia por quê nem como sair dela.
 */
export function ListSliceBanner({
  label,
  total,
  singular,
  plural,
  clearHref,
}: {
  label: string;
  total: number;
  singular: string;
  plural: string;
  clearHref: string;
}) {
  return (
    <div
      data-testid="list-slice-banner"
      className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-info-border bg-info-bg px-4 py-2.5 text-sm"
    >
      <p className="text-fg">
        <span className="text-fg-secondary">Recorte do painel:</span>{" "}
        <span className="font-semibold">{label}</span>
        <span className="text-fg-secondary">
          {" · "}
          <span data-testid="list-slice-total" className="font-semibold tabular-nums text-fg">
            {total}
          </span>{" "}
          {total === 1 ? singular : plural}
        </span>
      </p>
      <Link
        href={clearHref}
        className="font-semibold text-primary-text hover:text-primary-text-hover"
      >
        Limpar recorte
      </Link>
    </div>
  );
}
