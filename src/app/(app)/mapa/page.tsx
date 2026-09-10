import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CtoMapLayer } from "@/components/map/CtoMapLayer";
import { isCtoNetworkEnabled } from "@/lib/cto";
import { requirePageProfile } from "@/lib/guards";
import {
  availableMapModes,
  getCtoMapInitialView,
  getMapTileConfig,
  type MapInitialView,
} from "@/lib/map-config";
import { parseMapViewParams, type MapViewState } from "@/lib/map-view-params";

export const metadata: Metadata = {
  title: "Mapa Operacional",
};

/**
 * # Mapa Operacional — `CTO-3.2`, estendido na `CTO-3.2.1`
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
 * provedores de tiles   ambiente, resolvidos aqui (`map-config`)
 * modos disponíveis     consequência da configuração, não do navegador
 * vista inicial         a URL, se veio; senão os extremos das caixas; senão o país
 * canOpenDetail         `/ctos/[id]` é de ADMIN — o botão segue a página
 * ```
 *
 * Nenhum desses valores é negociável pelo cliente. O usuário escolhe o MODO;
 * ele nunca escolhe a URL do provedor.
 */
export default async function MapaOperacionalPage({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
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

  const tiles = getMapTileConfig();
  const modes = availableMapModes(tiles);

  /*
    A vista da URL é lida e VALIDADA no servidor, campo a campo.

    Ela é entrada de usuário: qualquer link montado por terceiro chega aqui.
    Uma latitude `1e400` ou um zoom negativo chegando ao Leaflet não produz um
    mapa em lugar errado — produz uma exceção que derruba o componente. O que
    passa daqui já está dentro das faixas do planeta.
  */
  const daUrl: Partial<MapViewState> = parseMapViewParams(searchParams);

  /*
    Precedência do enquadramento, e cada degrau responde uma pergunta diferente:

      1. a URL      "volte exatamente para onde eu estava"
      2. as caixas  "esta é a sua rede"
      3. o país     "não sei onde você opera"

    O primeiro é o que conserta o defeito que o dono encontrou: sem ele, voltar
    de uma CTO devolvia o operador ao enquadramento inicial e ele perdia o
    bairro, o zoom e o contexto inteiro.
  */
  const initialView: MapInitialView =
    daUrl.latitude !== undefined && daUrl.longitude !== undefined
      ? {
          kind: "point",
          point: {
            latitude: daUrl.latitude,
            longitude: daUrl.longitude,
            zoom: daUrl.zoom ?? 15,
          },
        }
      : await getCtoMapInitialView(session.companyId);

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
        modes={modes}
        initialView={initialView}
        initialState={daUrl}
        /*
          O detalhe da CTO continua sendo de `ADMIN` (`/ctos/[id]` roda
          `requirePageProfile(["ADMIN"])`, e é lá que vivem CONNECT, MOVE e
          DISCONNECT). O `DISPATCHER` lê o mapa — decisão da `CTO-3.1` — e não
          ganha escrita nenhuma nesta fase.

          Esconder o botão é APRESENTAÇÃO. Quem barra é a página, e digitar a
          URL continua terminando no mesmo redirecionamento.
        */
        canOpenDetail={session.profile === "ADMIN"}
        /*
          Prop SEPARADA, e não um reuso de `canOpenDetail` — CTO-3.2.1d.

          Hoje as duas respondem `ADMIN`, e é tentador passar uma só. Mas elas
          respondem perguntas diferentes — *"pode abrir a ficha?"* e *"pode
          mover a caixa?"* —, e colapsá-las faria uma futura mudança em uma
          alterar a outra em silêncio. Abrir a leitura do detalhe ao
          `DISPATCHER`, por exemplo, lhe daria escrita de coordenada de brinde.

          Continua sendo APRESENTAÇÃO: quem barra é `requireCtoAccess` na rota,
          que exige `ADMIN` e a capability antes de qualquer escrita.
        */
        canEditPosition={session.profile === "ADMIN"}
      />
    </div>
  );
}
