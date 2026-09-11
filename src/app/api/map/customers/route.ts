import { AccessProfile, type ConnectivityStatus } from "@prisma/client";
import { jsonError, jsonOk, runApi } from "@/lib/api";
import { requireCtoAccess } from "@/lib/cto-access";
import { assertBoundingBox } from "@/lib/cto-map";
import {
  CUSTOMER_MAP_MAX_MARKERS,
  getCustomerMapView,
} from "@/lib/operational-map";

/**
 * `GET /api/map/customers?north=&south=&east=&west=&connectivity=&openOs=`
 *
 * Os clientes **cadastralmente ativos** localizáveis num recorte, com a
 * conectividade que a tela da OS já usa.
 *
 * ## Quem lê: `ADMIN`, e só
 *
 * O mapa de CTO é lido por `ADMIN` e `DISPATCHER` desde a `CTO-3.1`. A camada
 * de clientes **não** herda isso, e a diferença é deliberada: mostrar onde cada
 * assinante mora é uma superfície de dado pessoal que nenhuma decisão aprovada
 * estendeu ao despacho. Ampliar por efeito colateral de uma fase de mapa seria
 * decidir política de privacidade dentro de uma implementação.
 *
 * Se essa ampliação for desejada, ela é decisão de produto própria — e o
 * `DISPATCHER` continua com o mapa de caixas e de OS abertas, que é o que o
 * trabalho dele pede.
 *
 * `TECHNICIAN` continua fora da superfície web, como em todo o módulo.
 *
 * ## `GET` puro, sem `assertSameOrigin`
 *
 * Mesma escolha das outras leituras do módulo: a proteção de origem existe para
 * mutação, e uniformidade aqui importa — uma leitura que exige origem entre
 * vizinhas que não exigem é a que alguém "conserta" tirando a verificação do
 * lugar errado.
 */
export const dynamic = "force-dynamic";

/** Os únicos valores aceitos no filtro. Qualquer outro é recusado, não ignorado. */
const CONECTIVIDADE_VALIDA: ConnectivityStatus[] = [
  "ONLINE",
  "OFFLINE",
  "UNKNOWN",
];

export async function GET(request: Request) {
  return runApi(async () => {
    const access = await requireCtoAccess(request, [AccessProfile.ADMIN]);
    if (!access.ok) return access.response;

    const params = new URL(request.url).searchParams;

    const numero = (nome: string): unknown => {
      const bruto = params.get(nome);
      return bruto === null || bruto.trim() === "" ? undefined : Number(bruto);
    };

    const bbox = assertBoundingBox({
      north: numero("north"),
      south: numero("south"),
      east: numero("east"),
      west: numero("west"),
    });

    /*
      Filtro por ALLOWLIST, e recusando o desconhecido.

      Ignorar um valor inválido em silêncio devolveria a lista inteira para quem
      pediu um subconjunto — e a tela concluiria que o filtro não tem resultado
      nenhum a esconder, quando na verdade ele nunca foi aplicado.
    */
    const conectividade = params
      .getAll("connectivity")
      .flatMap((v) => v.split(","))
      .map((v) => v.trim().toUpperCase())
      .filter((v) => v !== "");

    for (const valor of conectividade) {
      if (!(CONECTIVIDADE_VALIDA as string[]).includes(valor)) {
        return jsonError("Filtro de conectividade inválido.", 400);
      }
    }

    const openOsBruto = params.get("openOs");
    if (openOsBruto !== null && !["true", "false"].includes(openOsBruto)) {
      return jsonError("Filtro de OS aberta inválido.", 400);
    }

    const map = await getCustomerMapView(access.session.companyId, {
      bbox,
      // O teto é do SERVIDOR. O parâmetro do cliente pode encolher, nunca crescer.
      limit: CUSTOMER_MAP_MAX_MARKERS,
      connectivity:
        conectividade.length > 0
          ? (conectividade as ConnectivityStatus[])
          : undefined,
      withOpenServiceOrder:
        openOsBruto === null ? undefined : openOsBruto === "true",
    });

    return jsonOk({ map });
  });
}
