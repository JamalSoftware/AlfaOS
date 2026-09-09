import { AccessProfile } from "@prisma/client";
import { jsonOk, runApi } from "@/lib/api";
import { requireCtoAccess } from "@/lib/cto-access";
import {
  assertBoundingBox,
  CTO_MAP_MAX_MARKERS,
  getCtoMapView,
} from "@/lib/cto-map";

/**
 * `GET /api/ctos/map?north=&south=&east=&west=&limit=`
 *
 * As caixas visíveis num recorte do mapa, com o resumo operacional de cada uma.
 *
 * ## O caminho, e por que ele não colide
 *
 * `map` é segmento estático e vence `[id]` no roteamento do Next. Não há
 * ambiguidade real: os ids são `cuid()` e nunca valem `"map"`. O nome segue a
 * convenção que `/api/ctos/[id]/capacity` e `/api/ctos/[id]/active` já usam —
 * substantivo curto, sem verbo.
 *
 * ## `GET` puro, sem `assertSameOrigin`
 *
 * A proteção de origem existe para mutação; esta rota não escreve nada. É a
 * mesma escolha das outras leituras do módulo (`GET /api/ctos`,
 * `GET /api/ctos/[id]`), e uniformidade aqui importa: uma leitura que exige
 * origem e as vizinhas não exigem é a que alguém acaba "consertando" tirando a
 * verificação do lugar errado.
 *
 * ## Quem lê
 *
 * `ADMIN` **e** `DISPATCHER`. O `C-07` congelou que leitura é aberta *"por fase
 * que precise dela, não por antecipação"*, e o mapa operacional é do despacho —
 * esta é a fase. **Nenhum perfil novo e nenhuma capability nova**:
 * `requireCtoAccess` já recebe a lista de perfis, e a capability de rede
 * continua sendo a mesma.
 *
 * `TECHNICIAN` continua fora: ele lê CTO pelo Field, dentro de uma OS
 * `IN_PROGRESS` que é dele (`CTO-2.4`). E **nada de escrita muda** — `CONNECT`,
 * `MOVE` e `DISCONNECT` seguem exatamente como a `CTO-2` os entregou.
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

    /*
      `Number` sobre ausência daria `NaN`, e `NaN` é recusado adiante — mas a
      mensagem sairia falando de valor inválido para um parâmetro que
      simplesmente não veio. Traduzir ausência em `undefined` deixa a validação
      dizer a frase certa.
    */
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

    const bruto = numero("limit");
    const limit =
      typeof bruto === "number" && Number.isInteger(bruto) && bruto > 0
        ? Math.min(bruto, CTO_MAP_MAX_MARKERS)
        : undefined;

    /*
      `companyId` vem da SESSÃO, e não existe caminho para ele vir da query.
      Um mapa que aceitasse tenant do cliente seria o atalho mais curto para a
      rede do concorrente — e uma coordenada isolada já é vazamento.
    */
    const view = await getCtoMapView(access.session.companyId, { bbox, limit });

    return jsonOk({ map: view });
  });
}
