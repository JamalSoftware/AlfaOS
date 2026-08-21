import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/ModulePlaceholder";
import { requirePageProfile } from "@/lib/guards";

export const metadata: Metadata = {
  title: "Técnicos",
};

export default async function TechniciansPage() {
  await requirePageProfile(["ADMIN", "DISPATCHER"]);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Técnicos</h1>
      </div>
      <ModulePlaceholder
        icon="technicians"
        title="Técnicos"
        description="O cadastro e a gestão de técnicos serão implementados junto com o fluxo de Ordens de Serviço."
      />
    </div>
  );
}
