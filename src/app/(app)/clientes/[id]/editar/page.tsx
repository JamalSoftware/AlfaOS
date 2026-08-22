import type { Metadata } from "next";
import Link from "next/link";
import { requirePageProfile } from "@/lib/guards";
import { getCompanyCustomer } from "@/lib/customers";
import { CustomerForm } from "@/components/CustomerForm";
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

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/clientes"
          className="text-sm font-medium text-blue-600 hover:text-blue-700"
        >
          ← Voltar para clientes
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">
          Editar cliente
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Atualize os dados do cliente {customer.name}.
        </p>
      </div>

      <div className="max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <CustomerForm mode="edit" customer={customer} backHref="/clientes" />
      </div>
    </div>
  );
}
