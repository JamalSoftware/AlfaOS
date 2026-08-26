import type { Metadata } from "next";
import Link from "next/link";
import { requirePageProfile } from "@/lib/guards";
import { getCompanyCustomer } from "@/lib/customers";
import { listCustomerConnections } from "@/lib/customer-connections";
import { CustomerForm } from "@/components/CustomerForm";
import { CustomerConnectionsPanel } from "@/components/CustomerConnectionsPanel";
import { notFound } from "next/navigation";

export const metadata: Metadata = {
  title: "Editar cliente",
};

export default async function EditCustomerPage({
  params,
}: {
  params: { id: string };
}) {
  const session = await requirePageProfile(["ADMIN", "DISPATCHER"]);

  const customer = await getCompanyCustomer(session.companyId, params.id);
  if (!customer) {
    notFound();
  }

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
          href="/clientes"
          className="text-sm font-medium text-primary-text hover:text-primary-text-hover"
        >
          ← Voltar para clientes
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
          <CustomerForm mode="edit" customer={customer} backHref="/clientes" />
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
