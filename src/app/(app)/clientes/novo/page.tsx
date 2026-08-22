import type { Metadata } from "next";
import Link from "next/link";
import { requirePageProfile } from "@/lib/guards";
import { CustomerForm } from "@/components/CustomerForm";

export const metadata: Metadata = {
  title: "Novo cliente",
};

export default async function NewCustomerPage() {
  await requirePageProfile(["ADMIN", "DISPATCHER"]);

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/clientes"
          className="text-sm font-medium text-blue-600 hover:text-blue-700"
        >
          ← Voltar para clientes
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">Novo cliente</h1>
        <p className="mt-1 text-sm text-slate-500">
          Cadastre um cliente da sua empresa.
        </p>
      </div>

      <div className="max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <CustomerForm mode="create" backHref="/clientes" />
      </div>
    </div>
  );
}
