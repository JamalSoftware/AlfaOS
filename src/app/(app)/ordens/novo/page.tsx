import type { Metadata } from "next";
import Link from "next/link";
import { requirePageProfile } from "@/lib/guards";
import { listCustomerOptions } from "@/lib/customers";
import { listServiceOrderTypeOptions } from "@/lib/service-order-types";
import { ServiceOrderForm } from "@/components/ServiceOrderForm";

export const metadata: Metadata = {
  title: "Nova OS",
};

export default async function NewOrderPage() {
  const session = await requirePageProfile(["ADMIN", "DISPATCHER"]);
  const [customers, types] = await Promise.all([
    listCustomerOptions(session.companyId),
    listServiceOrderTypeOptions(session.companyId),
  ]);

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/ordens"
          className="text-sm font-medium text-blue-600 hover:text-blue-700"
        >
          ← Voltar para ordens de serviço
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">Nova OS</h1>
        <p className="mt-1 text-sm text-slate-500">
          Crie uma ordem de serviço manualmente.
        </p>
      </div>

      <div className="max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <ServiceOrderForm customers={customers} types={types} />
      </div>
    </div>
  );
}
