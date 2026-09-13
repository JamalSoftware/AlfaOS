import type { Metadata } from "next";
import { AccessProfile } from "@prisma/client";
import { requirePageProfile } from "@/lib/guards";
import { isCtoNetworkEnabled } from "@/lib/cto";
import { loadGlobalSearch } from "@/lib/global-search";
import { GLOBAL_SEARCH_PROFILES } from "@/lib/navigation";
import { GlobalSearchView } from "@/components/GlobalSearchView";

export const metadata: Metadata = {
  title: "Busca",
};

/**
 * Busca global do AlfaOS — GS-1 (PRD §384).
 *
 * ADMIN e DISPATCHER, os perfis das listagens que ela resume. O TECHNICIAN é
 * mandado para a tela dele pelo mesmo guarda de toda página; o domínio confere
 * de novo, porque esconder o campo do menu é conveniência e não controle.
 */
export default async function GlobalSearchPage({
  searchParams,
}: {
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  const session = await requirePageProfile([...GLOBAL_SEARCH_PROFILES]);
  const viewer = { companyId: session.companyId, profile: session.profile };

  // Em sequência, não em paralelo: uma visita não abre uma conexão por leitura
  // (a lição da TL-1). A dica só cita CTOs para quem pode achá-las.
  const section = await loadGlobalSearch(viewer, searchParams.q);
  const includesCtos =
    session.profile === AccessProfile.ADMIN &&
    (await isCtoNetworkEnabled(session.companyId).catch(() => false));

  return <GlobalSearchView section={section} includesCtos={includesCtos} />;
}
