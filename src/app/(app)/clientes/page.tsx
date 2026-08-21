import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/ModulePlaceholder";
import { requirePageProfile } from "@/lib/guards";

export const metadata: Metadata = {
  title: "Clientes",
};

export default async function ClientsPage() {
  await requirePageProfile(["ADMIN", "DISPATCHER"]);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Clientes</h1>
      </div>
      <ModulePlaceholder
        icon="clients"
        title="Clientes"
        description="O módulo de clientes será implementado em uma próxima versão, com sincronização futura com o ERP ReceitaNet."
      />
    </div>
  );
}
