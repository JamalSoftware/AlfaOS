import type { Metadata } from "next";
import Link from "next/link";
import { requirePageProfile } from "@/lib/guards";
import { getCompanyCustomer } from "@/lib/customers";
import {
  getCompanyServiceOrder,
  formatServiceOrderNumber,
} from "@/lib/service-orders";
import { listCustomerConnections } from "@/lib/customer-connections";
import { CustomerForm } from "@/components/CustomerForm";
import { CustomerConnectionsPanel } from "@/components/CustomerConnectionsPanel";
import { ReceitanetOrderSyncPanel } from "@/components/ReceitanetOrderSyncPanel";
import { CustomerTimelineSection } from "@/components/CustomerTimelineSection";
import { CustomerLocationCard } from "@/components/CustomerLocationCard";
import { getCustomerLocationCard } from "@/lib/customer-location-card";
import {
  CUSTOMER_TIMELINE_MAX,
  CUSTOMER_TIMELINE_PAGE_SIZE,
  loadCustomerTimeline,
  parseTimelineLimit,
} from "@/lib/customer-timeline";
import { OPERATIONAL_MAP_PATH, buildReturnTo, parseReturnTo } from "@/lib/return-to";
import { buildMapViewQuery, parseMapViewParams } from "@/lib/map-view-params";
import { notFound } from "next/navigation";

export const metadata: Metadata = {
  title: "Editar cliente",
};

/** Para onde o botão de voltar aponta, e o que ele diz. */
interface Volta {
  href: string;
  label: string;
}

const VOLTA_PADRAO: Volta = {
  href: "/clientes",
  label: "← Voltar para clientes",
};

/**
 * Resolve o destino de volta a partir da query string.
 *
 * Duas checagens, e as duas são necessárias:
 *
 * 1. **Formato**, em `parseReturnTo` — allowlist fechada, que é o que impede
 *    redirect aberto. Sem ela, um link montado por terceiro leva o operador
 *    autenticado para fora do AlfaOS, numa tela que imita a de origem.
 *
 * 2. **Tenant**, aqui — a OS é resolvida sob a empresa da SESSÃO. Um id válido
 *    de outra empresa passa pela primeira checagem e morre nesta: o botão cai
 *    no padrão em vez de virar um link que revela que aquela OS existe.
 *
 * Falhar aqui nunca é erro de tela. Um destino de volta ruim vira "voltar para
 * clientes", que sempre funciona.
 */
async function resolverVolta(
  companyId: string,
  todos: Record<string, string | string[] | undefined> | undefined,
): Promise<Volta> {
  const bruto = todos?.returnTo;
  const destino = parseReturnTo(Array.isArray(bruto) ? bruto[0] : bruto);
  /*
    O MAPA passou a alcançar esta tela — `CTO-3.2.2`.

    Até aqui o comentário anterior estava certo: não existia caminho do mapa
    para o cadastro de cliente, e `operational-map` caía no padrão. Com a camada
    de clientes, existe — e o operador que clicou num ponto precisa voltar para
    o bairro onde estava, e não para a listagem inteira.

    A vista NÃO viaja dentro desta string. Ela vai nos parâmetros próprios do
    mapa, cada um validado por `parseMapViewParams`, e o destino é REMONTADO a
    partir dos valores já conferidos — nada do que o cliente escreveu é ecoado
    na `href`. É o mesmo desenho que a `CTO-3.2.1` usou para a CTO.
  */
  if (destino?.kind === "operational-map") {
    const query = buildMapViewQuery(parseMapViewParams(todos));
    return {
      href: query ? `${OPERATIONAL_MAP_PATH}?${query}` : OPERATIONAL_MAP_PATH,
      label: "← Mapa Operacional",
    };
  }

  if (!destino || destino.kind !== "order") {
    return VOLTA_PADRAO;
  }

  const order = await getCompanyServiceOrder(companyId, destino.orderId);
  if (!order) {
    return VOLTA_PADRAO;
  }

  return {
    href: `/ordens/${order.id}`,
    // O número OPERACIONAL, não o `id`: "Voltar para OS cmt7prb4" não é
    // dizível nem reconhecível. A rota continua usando o id.
    label: `← Voltar para ${formatServiceOrderNumber(order)}`,
  };
}

/**
 * "Ver eventos anteriores" é esta mesma tela com um limite maior — TL-1.
 *
 * A origem da navegação sobrevive ao clique, e pelo mesmo desenho do botão de
 * voltar: o `returnTo` é REMONTADO a partir do destino já validado, e a vista
 * do mapa a partir dos parâmetros já conferidos. Nada do que veio na query é
 * ecoado — um `returnTo` que a allowlist recusou simplesmente não segue.
 */
function linkVerMais(
  customerId: string,
  todos: Record<string, string | string[] | undefined> | undefined,
  limit: number,
): string | null {
  if (limit >= CUSTOMER_TIMELINE_MAX) return null;
  const bruto = todos?.returnTo;
  const destino = parseReturnTo(Array.isArray(bruto) ? bruto[0] : bruto);
  const query = new URLSearchParams();
  if (destino) query.set("returnTo", buildReturnTo(destino));
  if (destino?.kind === "operational-map") {
    new URLSearchParams(buildMapViewQuery(parseMapViewParams(todos))).forEach((valor, chave) =>
      query.set(chave, valor),
    );
  }
  query.set("historico", String(limit + CUSTOMER_TIMELINE_PAGE_SIZE));
  return `/clientes/${encodeURIComponent(customerId)}/editar?${query.toString()}#historico`;
}

export default async function EditCustomerPage({
  params: paramsPromise,
  searchParams: searchParamsPromise,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await paramsPromise;
  const searchParams = await searchParamsPromise;
  const session = await requirePageProfile(["ADMIN", "DISPATCHER"]);

  const customer = await getCompanyCustomer(session.companyId, params.id);
  if (!customer) {
    notFound();
  }

  const volta = await resolverVolta(session.companyId, searchParams);

  // Somente ADMIN gerencia credencial de acesso. O painel inteiro fica fora da
  // árvore para o DISPATCHER — nada de renderizar controles que a API recusa.
  const isAdmin = session.profile === "ADMIN";
  const connections = isAdmin
    ? await listCustomerConnections(session.companyId, params.id)
    : [];

  /*
    Localização do cliente — RC-LOC-03, e só para o ADMIN.

    É a mesma fronteira do Mapa Operacional V1: a posição nominal da carteira
    é do ADMIN, e o DISPATCHER não a ganhou (PRD §376). O cartão é somente
    leitura e lê a AUTORIDADE (`CustomerLocation`), nunca a projeção.
  */
  const locationCard = isAdmin
    ? await getCustomerLocationCard(session.companyId, customer.id)
    : null;

  // O histórico lê com a empresa e o perfil da SESSÃO: é o perfil que decide
  // se CTO e porta entram, e nunca um parâmetro da tela.
  const historicoBruto = searchParams?.historico;
  const limiteHistorico = parseTimelineLimit(
    Array.isArray(historicoBruto) ? historicoBruto[0] : historicoBruto,
  );
  const historico = await loadCustomerTimeline(
    { companyId: session.companyId, profile: session.profile },
    customer.id,
    limiteHistorico,
  );

  return (
    <div>
      <div className="mb-6">
        <Link
          data-testid="customer-back-link"
          href={volta.href}
          className="text-sm font-medium text-primary-text hover:text-primary-text-hover"
        >
          {volta.label}
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-fg">
          Editar cliente
        </h1>
        <p className="mt-1 text-sm text-fg-muted">
          Atualize os dados do cliente {customer.name}.
        </p>
      </div>

      <div className="max-w-2xl space-y-6">
        <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
          {/*
            O formulário volta para o MESMO lugar que o link do topo: cancelar
            e salvar não podem levar a destinos diferentes.
          */}
          <CustomerForm mode="edit" customer={customer} backHref={volta.href} />
        </div>

        {locationCard && <CustomerLocationCard card={locationCard} />}

        {/*
          Sincronizacao das OS abertas no provedor.

          ADMIN e DISPATCHER — os mesmos perfis que a rota aceita. O tecnico
          nao dispara sincronizacao administrativa; ele trabalha a OS depois
          que ela existe e lhe e atribuida.
        */}
        <ReceitanetOrderSyncPanel
          customerId={customer.id}
          linked={
            customer.externalProvider === "RECEITANET" &&
            Boolean(customer.externalId)
          }
        />

        {isAdmin && (
          <CustomerConnectionsPanel
            customerId={customer.id}
            connections={connections}
          />
        )}

        <CustomerTimelineSection
          section={historico}
          loadMoreHref={linkVerMais(customer.id, searchParams, limiteHistorico)}
        />
      </div>
    </div>
  );
}
