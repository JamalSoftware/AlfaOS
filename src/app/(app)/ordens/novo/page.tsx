import type { Metadata } from "next";
import Link from "next/link";
import { requirePageProfile } from "@/lib/guards";
import { listCustomerOptions } from "@/lib/customers";
import { listServiceOrderTypeOptions } from "@/lib/service-order-types";
import { prisma } from "@/lib/prisma";
import { ServiceOrderForm } from "@/components/ServiceOrderForm";

export const metadata: Metadata = {
  title: "Nova OS",
};

export default async function NewOrderPage() {
  const session = await requirePageProfile(["ADMIN", "DISPATCHER"]);
  const [customers, types, integration] = await Promise.all([
    listCustomerOptions(session.companyId),
    listServiceOrderTypeOptions(session.companyId),
    prisma.eRPIntegration.findUnique({
      where: { companyId: session.companyId },
      select: { provider: true, enabled: true },
    }),
  ]);

  /**
   * Busca no ERP só é oferecida quando há integração habilitada de um
   * provider que realmente a implementa. O MockERP não implementa busca de
   * cliente, e mostrar o bloco para ele daria um botão que sempre falha.
   */
  const erpLookup = {
    enabled: integration?.enabled === true && integration.provider === "RECEITANET",
    providerLabel: "ReceitaNet",
  };

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/ordens"
          className="text-sm font-medium text-primary-text hover:text-primary-text-hover"
        >
          ← Voltar para ordens de serviço
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-fg">Nova OS</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Crie uma ordem de serviço manualmente.
        </p>
      </div>

      <div className="max-w-2xl rounded-2xl border border-border bg-surface p-6 shadow-sm">
        <ServiceOrderForm
          customers={customers}
          types={types}
          erpLookup={erpLookup}
        />
      </div>
    </div>
  );
}
