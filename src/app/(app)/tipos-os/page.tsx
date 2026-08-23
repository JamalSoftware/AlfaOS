import type { Metadata } from "next";
import { requirePageProfile } from "@/lib/guards";
import { listCompanyServiceOrderTypes } from "@/lib/service-order-types";
import { EmptyState } from "@/components/EmptyState";
import { ServiceOrderTypeManager } from "./ServiceOrderTypeManager";

export const metadata: Metadata = {
  title: "Tipos de OS",
};

export default async function ServiceOrderTypesPage() {
  const session = await requirePageProfile(["ADMIN"]);

  // Inclui inativos: o ADMIN precisa enxergar o que desativou para poder
  // reativar. Desativado some do formulário de nova OS, não desta tela.
  const types = await listCompanyServiceOrderTypes(session.companyId, {
    includeInactive: true,
  });

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Tipos de OS</h1>
        <p className="mt-1 text-sm text-slate-500">
          Catálogo da sua empresa. Desativar um tipo o remove das novas OS e não
          altera nenhuma ordem já registrada.
        </p>
      </div>

      {types.length === 0 && (
        <div className="mb-6 rounded-2xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            title="Nenhum tipo cadastrado"
            description="Cadastre ao menos um tipo para conseguir abrir ordens de serviço."
          />
        </div>
      )}

      <ServiceOrderTypeManager types={types} />
    </div>
  );
}
