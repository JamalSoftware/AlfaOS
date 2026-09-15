import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isCtoNetworkEnabled } from "@/lib/cto";
import { getCtoClientConnectivity } from "@/lib/cto-client-connectivity";
import { getOperationalCtoDetail } from "@/lib/cto-read-model";
import { requirePageProfile } from "@/lib/guards";
import { buildMapViewQuery, parseMapViewParams } from "@/lib/map-view-params";
import { OPERATIONAL_MAP_PATH, parseReturnTo } from "@/lib/return-to";
import { CtoDetailManager } from "./CtoDetailManager";

export const metadata: Metadata = {
  title: "CTO",
};

/** Para onde o botão de voltar aponta, e o que ele diz. */
interface Volta {
  href: string;
  label: string;
}

const VOLTA_PADRAO: Volta = { href: "/ctos", label: "← CTOs" };

/**
 * Resolve o destino de volta a partir da query string.
 *
 * ## O defeito que isto corrige
 *
 * Na validação da `CTO-3.2` o dono abriu uma CTO **pelo mapa**, clicou em
 * voltar, e caiu na listagem `/ctos`. Do ponto de vista de quem opera, o
 * sistema perdeu o lugar onde ele estava — e a listagem não tem nem o bairro,
 * nem o zoom, nem a caixa em destaque.
 *
 * ## Por que não `router.back()`
 *
 * Porque ele responde *"a página anterior do navegador"*, e essa não é a mesma
 * pergunta que *"de onde este fluxo veio"*. `F5` no detalhe, link colado, aba
 * nova e um `back` depois de três navegações produzem históricos diferentes —
 * e em todos eles o botão precisaria continuar dizendo a mesma coisa. A origem
 * é **explícita**, viaja na URL, e por isso sobrevive a tudo isso.
 *
 * ## Duas checagens, e as duas são necessárias
 *
 * 1. **A origem**, por `parseReturnTo` — allowlist ancorada, comparação exata
 *    contra rotas conhecidas. É o que impede redirect aberto: um link montado
 *    por terceiro levaria o operador autenticado para fora do AlfaOS, numa tela
 *    que imita a de origem.
 *
 * 2. **A vista**, por `parseMapViewParams` — cada campo conferido, e o destino
 *    **remontado** por `buildMapViewQuery` a partir do que passou. Nada do que
 *    o cliente escreveu é ecoado de volta na `href`; o que sai é uma query
 *    construída de valores já validados.
 *
 * Falhar aqui nunca é erro de tela: um destino ruim vira "← CTOs", que sempre
 * funciona.
 */
function resolverVolta(
  searchParams: Record<string, string | string[] | undefined> | undefined,
): Volta {
  const origem = parseReturnTo(
    Array.isArray(searchParams?.returnTo)
      ? searchParams?.returnTo[0]
      : searchParams?.returnTo,
  );

  if (origem?.kind !== "operational-map") {
    return VOLTA_PADRAO;
  }

  const query = buildMapViewQuery(parseMapViewParams(searchParams));
  return {
    href: query ? `${OPERATIONAL_MAP_PATH}?${query}` : OPERATIONAL_MAP_PATH,
    label: "← Mapa Operacional",
  };
}

export default async function CtoDetailPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const session = await requirePageProfile(["ADMIN"]);

  if (!(await isCtoNetworkEnabled(session.companyId))) {
    notFound();
  }

  // `getCto` já filtra por `companyId` no predicado. Id de outra empresa cai
  // aqui como inexistente — que é exatamente o que ele deve parecer.
  const cto = await getOperationalCtoDetail(session.companyId, params.id);
  if (!cto) {
    notFound();
  }

  /*
    Os clientes da caixa — RC-1D. Só DEPOIS de a caixa ter sido provada desta
    empresa, e só leitura: o mesmo resumo e a mesma lista por porta do popup do
    mapa, sobre o último snapshot conhecido. Nada aqui chama provider.
  */
  const clientes = await getCtoClientConnectivity(session.companyId, cto.id);

  const volta = resolverVolta(searchParams);

  return (
    <div>
      <div className="mb-6">
        <Link
          href={volta.href}
          data-testid="cto-back-link"
          className="text-sm text-fg-muted transition-colors hover:text-fg"
        >
          {volta.label}
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-fg">{cto.name}</h1>
        <p className="mt-1 text-sm text-fg-muted">
          {cto.capacity} portas
          {cto.code ? ` · código ${cto.code}` : ""}
          {cto.active ? "" : " · inativa"}
        </p>
      </div>

      <CtoDetailManager
        cto={cto}
        clientes={clientes}
        /*
          O instante da renderização, para a idade da leitura. Servidor e
          navegador calculam "há X min" contra o MESMO relógio — sem isso, a
          hidratação poderia discordar na virada de um minuto.
        */
        renderedAt={new Date().toISOString()}
      />
    </div>
  );
}
