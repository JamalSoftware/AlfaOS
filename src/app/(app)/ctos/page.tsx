import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BackToDashboardLink } from "@/components/BackToDashboardLink";
import { EmptyState } from "@/components/EmptyState";
import { ListSliceBanner } from "@/components/ListSliceBanner";
import { isCtoNetworkEnabled, listCompanyCtos } from "@/lib/cto";
import {
  getCompanyCtoStates,
  matchesCtoAttention,
  parseCtoAttentionFilter,
  type CtoAttentionFilter,
} from "@/lib/cto-attention";
import {
  sliceEmptyState,
  type DashboardSliceKey,
} from "@/lib/dashboard-slice-copy";
import { requirePageProfile } from "@/lib/guards";
import { CtoListManager, type CtoSliceContext } from "./CtoListManager";

const SLICE_KEY: Record<CtoAttentionFilter, DashboardSliceKey> = {
  defeito: "ctos-com-defeito",
  "com-os-abertas": "ctos-com-os-abertas",
};

export const metadata: Metadata = {
  title: "CTOs",
};

interface PageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function CtosPage({ searchParams: searchParamsPromise }: PageProps) {
  const searchParams = await searchParamsPromise;
  const session = await requirePageProfile(["ADMIN"]);

  /*
    Capability desligada = a página não existe.

    `notFound()` e não uma tela de "módulo indisponível": a segunda anunciaria à
    empresa que existe um módulo CTO que ela não contratou. É a mesma escolha
    que as rotas de API fazem com 404 — e as duas são independentes, porque
    esconder o item do menu é conveniência e nunca controle.
  */
  if (!(await isCtoNetworkEnabled(session.companyId))) {
    notFound();
  }

  // Inclui inativas: o ADMIN precisa enxergar o que inativou para reativar.
  const todas = await listCompanyCtos(session.companyId, {
    includeInactive: true,
  });

  /*
    Recorte do painel (DASH-1): "defeito" ou "com-os-abertas".

    O estado de cada caixa vem de `getCompanyCtoStates`, a MESMA leitura que
    conta o cartão — então a lista mostra exatamente as caixas que o cartão
    contou. A lista não é paginada, e o filtro em memória é sobre as caixas da
    empresa, que já estão aqui de qualquer jeito.
  */
  const situacao = parseCtoAttentionFilter(searchParams.situacao);
  const estados = situacao ? await getCompanyCtoStates(session.companyId) : null;
  const ctos =
    situacao && estados
      ? todas.filter((cto) => {
          const estado = estados.get(cto.id);
          return estado ? matchesCtoAttention(estado, situacao) : false;
        })
      : todas;

  /*
    A razão de cada caixa estar no recorte, só das caixas listadas: estado
    operacional, portas danificadas e OS abertas — os números da mesma leitura
    que filtrou, então a coluna nunca discorda do recorte.
  */
  let sliceContext: CtoSliceContext | null = null;
  if (situacao && estados) {
    const byCto: CtoSliceContext["byCto"] = {};
    for (const cto of ctos) {
      const estado = estados.get(cto.id);
      if (estado) {
        byCto[cto.id] = {
          status: estado.status,
          damagedPortCount: estado.damagedPortCount,
          openServiceOrderCount: estado.openServiceOrderCount,
        };
      }
    }
    sliceContext = { filter: situacao, byCto };
  }
  const sliceKey = situacao ? SLICE_KEY[situacao] : null;
  const sliceEmpty = sliceKey ? sliceEmptyState(sliceKey, false) : null;

  return (
    <div>
      {sliceKey && <BackToDashboardLink />}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-fg">CTOs</h1>
        <p className="mt-1 text-sm text-fg-muted">
          As caixas de terminação óptica da sua rede de distribuição. Cadastre
          pelo nome que a sua operação usa no campo.
        </p>
      </div>

      {sliceKey && (
        <ListSliceBanner sliceKey={sliceKey} total={ctos.length} clearHref="/ctos" />
      )}

      {!sliceKey && todas.length === 0 && (
        <div className="mb-6 rounded-2xl border border-border bg-surface shadow-sm">
          <EmptyState
            title="Nenhuma CTO cadastrada"
            description="Cadastre a primeira caixa para que o técnico saiba onde o cliente está conectado."
          />
        </div>
      )}

      {sliceEmpty && ctos.length === 0 && (
        <div className="mb-6 rounded-2xl border border-border bg-surface shadow-sm">
          <EmptyState title={sliceEmpty.title} description={sliceEmpty.description} />
        </div>
      )}

      <CtoListManager ctos={ctos} slice={sliceContext} />
    </div>
  );
}
