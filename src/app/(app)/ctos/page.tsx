import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EmptyState } from "@/components/EmptyState";
import { isCtoNetworkEnabled, listCompanyCtos } from "@/lib/cto";
import { requirePageProfile } from "@/lib/guards";
import { CtoListManager } from "./CtoListManager";

export const metadata: Metadata = {
  title: "CTOs",
};

export default async function CtosPage() {
  const session = await requirePageProfile(["ADMIN"]);

  /*
    Capability desligada = a página não existe.

    `notFound()` e não uma tela de "módulo indisponível": a segunda anunciaria à
    empresa que existe um módulo CTO que ela não contratou. É a mesma escolha
    que as rotas de API fazem com 404 — e as duas são independentes, porque
    esconder o item do menu é conveniência e nunca controle.
  */
  if (!(await isCtoNetworkEnabled(session.companyId))) {
    notFound();
  }

  // Inclui inativas: o ADMIN precisa enxergar o que inativou para reativar.
  const ctos = await listCompanyCtos(session.companyId, {
    includeInactive: true,
  });

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-fg">CTOs</h1>
        <p className="mt-1 text-sm text-fg-muted">
          As caixas de terminação óptica da sua rede de distribuição. Cadastre
          pelo nome que a sua operação usa no campo.
        </p>
      </div>

      {ctos.length === 0 && (
        <div className="mb-6 rounded-2xl border border-border bg-surface shadow-sm">
          <EmptyState
            title="Nenhuma CTO cadastrada"
            description="Cadastre a primeira caixa para que o técnico saiba onde o cliente está conectado."
          />
        </div>
      )}

      <CtoListManager ctos={ctos} />
    </div>
  );
}
