import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/ModulePlaceholder";
import { requirePageProfile } from "@/lib/guards";

export const metadata: Metadata = {
  title: "Ordens de Serviço",
};

export default async function OrdersPage() {
  await requirePageProfile(["ADMIN", "DISPATCHER"]);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Ordens de Serviço</h1>
      </div>
      <ModulePlaceholder
        icon="orders"
        title="Ordens de Serviço"
        description="O fluxo completo de Ordens de Serviço será implementado nas próximas versões do AlfaOS."
      />
    </div>
  );
}
