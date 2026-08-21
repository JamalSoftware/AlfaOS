import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/ModulePlaceholder";
import { requirePageProfile } from "@/lib/guards";

export const metadata: Metadata = {
  title: "Minhas OS",
};

export default async function MyOrdersPage() {
  await requirePageProfile(["TECHNICIAN"]);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Minhas OS</h1>
      </div>
      <ModulePlaceholder
        icon="myorders"
        title="Minhas Ordens de Serviço"
        description="As ordens de serviço atribuídas a você aparecerão aqui assim que o fluxo de OS for implementado."
      />
    </div>
  );
}
