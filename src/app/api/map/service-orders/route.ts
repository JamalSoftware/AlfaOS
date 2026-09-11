import { AccessProfile } from "@prisma/client";
import { jsonOk, runApi } from "@/lib/api";
import { requireCtoAccess } from "@/lib/cto-access";
import { assertBoundingBox } from "@/lib/cto-map";
import {
  SERVICE_ORDER_MAP_MAX_MARKERS,
  getServiceOrderMapView,
} from "@/lib/operational-map";

/**
 * `GET /api/map/service-orders?north=&south=&east=&west=`
 *
 * As OS **abertas** cujo cliente é localizável num recorte.
 *
 * ## Quem lê: `ADMIN` e `DISPATCHER`
 *
 * Ao contrário da camada de clientes, esta acompanha o mapa de caixas. OS
 * aberta é exatamente o objeto de trabalho do despacho — esconder dele onde
 * estão os atendimentos seria esconder a própria função da tela.
 *
 * O que viaja aqui é o que o despacho já vê nas listagens de OS: número,
 * situação, tipo, cliente e técnico. A diferença em relação à camada de
 * clientes é o recorte da carteira: esta responde "onde há trabalho aberto", e
 * não "onde mora cada assinante".
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return runApi(async () => {
    const access = await requireCtoAccess(request, [
      AccessProfile.ADMIN,
      AccessProfile.DISPATCHER,
    ]);
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

    const map = await getServiceOrderMapView(access.session.companyId, {
      bbox,
      limit: SERVICE_ORDER_MAP_MAX_MARKERS,
    });

    return jsonOk({ map });
  });
}
