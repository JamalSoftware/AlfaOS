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
import { parseReturnTo } from "@/lib/return-to";
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
  bruto: string | string[] | undefined,
): Promise<Volta> {
  const destino = parseReturnTo(Array.isArray(bruto) ? bruto[0] : bruto);
  if (!destino || destino.kind === "customers") {
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

export default async function EditCustomerPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams?: { [key: string]: string | string[] | undefined };
}) {
  const session = await requirePageProfile(["ADMIN", "DISPATCHER"]);

  const customer = await getCompanyCustomer(session.companyId, params.id);
  if (!customer) {
    notFound();
  }

  const volta = await resolverVolta(session.companyId, searchParams?.returnTo);

  // Somente ADMIN gerencia credencial de acesso. O painel inteiro fica fora da
  // árvore para o DISPATCHER — nada de renderizar controles que a API recusa.
  const isAdmin = session.profile === "ADMIN";
  const connections = isAdmin
    ? await listCustomerConnections(session.companyId, params.id)
    : [];

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

        {isAdmin && (
          <CustomerConnectionsPanel
            customerId={customer.id}
            connections={connections}
          />
        )}
      </div>
    </div>
  );
}
