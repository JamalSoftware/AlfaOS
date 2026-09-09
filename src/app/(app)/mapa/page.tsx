import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CtoMapLayer } from "@/components/map/CtoMapLayer";
import { isCtoNetworkEnabled } from "@/lib/cto";
import { requirePageProfile } from "@/lib/guards";
import { getCtoMapInitialView, getMapTileConfig } from "@/lib/map-config";

export const metadata: Metadata = {
  title: "Mapa Operacional",
};

/**
 * # Mapa Operacional — `CTO-3.2`
 *
 * A superfície se chama **Mapa Operacional**, e não "Mapa de CTOs", porque é
 * ela que vai receber as camadas de técnico, cliente e ordem de serviço
 * (§136, §207). Nomear pela primeira camada garantiria que a segunda nascesse
 * como uma segunda tela — que é exatamente o que a §207 existe para evitar.
 *
 * Hoje há **uma** camada, e a página não esconde isso: o que aparece são CTOs.
 *
 * ## O que o servidor decide, e por quê
 *
 * ```text
 * perfil e capability   nunca no cliente
 * provedor de tiles     ambiente, resolvido aqui (`map-config`)
 * vista inicial         os extremos das caixas da empresa, ou o país
 * canOpenDetail         `/ctos/[id]` é de ADMIN — o botão segue a página
 * ```
 *
 * Nenhum desses valores viaja como parâmetro de URL, e nenhum deles é
 * negociável pelo cliente. A tela recebe o resultado.
 */
export default async function MapaOperacionalPage() {
  /*
    Perfil primeiro, capability depois — a ordem das PÁGINAS do módulo, e ela
    difere da das rotas de API de propósito.

    Numa rota, perfil-antes-de-capability vazaria a existência do módulo pelo
    403. Numa página, `requirePageProfile` **redireciona** em vez de responder
    403: quem não tem o perfil vai para a própria tela inicial e não descobre
    nada sobre o módulo. É o mesmo que `/ctos/page.tsx` faz.
  */
  const session = await requirePageProfile(["ADMIN", "DISPATCHER"]);

  if (!(await isCtoNetworkEnabled(session.companyId))) {
    notFound();
  }

  const [tiles, initialView] = await Promise.all([
    Promise.resolve(getMapTileConfig()),
    getCtoMapInitialView(session.companyId),
  ]);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-fg">Mapa Operacional</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Onde estão as caixas da sua rede e como cada uma está. Arraste ou dê
          zoom para carregar outra área.
        </p>
      </div>

      <CtoMapLayer
        tiles={tiles}
        initialView={initialView}
        /*
          O detalhe da CTO continua sendo de `ADMIN` (`/ctos/[id]` roda
          `requirePageProfile(["ADMIN"])`, e é lá que vivem CONNECT, MOVE e
          DISCONNECT). O `DISPATCHER` lê o mapa — decisão da `CTO-3.1` — e não
          ganha escrita nenhuma nesta fase.

          Esconder o botão é APRESENTAÇÃO. Quem barra é a página, e digitar a
          URL continua terminando no mesmo redirecionamento.
        */
        canOpenDetail={session.profile === "ADMIN"}
      />
    </div>
  );
}
