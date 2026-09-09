import type { CtoPortAdministrativeState } from "@prisma/client";
import { isPortWithinCapacity, type PublicCtoDetail } from "./cto";
import { summarizePortCounts } from "./cto-read-model";
import { badRequest } from "./errors";
import { prisma } from "./prisma";

/**
 * # A leitura geográfica da CTO — a primeira camada do Mapa Operacional
 *
 * O AlfaOS terá **um** motor de mapa (PRD §136, §207), e as camadas de técnico,
 * cliente e ordem de serviço vão operar sobre ele. Este módulo entrega a
 * primeira delas: *"nesta área visível, quais caixas da minha empresa existem e
 * como elas estão?"*
 *
 * **Nada aqui desenha nada.** Sem Leaflet, sem marker, sem cluster, sem tile —
 * a `CTO-3.1` é o contrato de dados, e ele nasce testável antes de existir um
 * pixel. É onde moram tenancy, teto e `N+1`, que são exatamente os três lugares
 * onde um mapa costuma quebrar.
 *
 * ## Uma autoridade para a contagem
 *
 * As contagens saem de `summarizePortCounts`, a mesma função que o detalhe
 * administrativo usa. A alternativa óbvia — um `GROUP BY` em SQL — seria mais
 * rápida e criaria uma segunda verdade sobre a mesma pergunta: quando a regra
 * mudasse, alguém teria de lembrar do SQL. A `CTO-2.2` já mostrou como esse
 * tipo de divergência se esconde (uma porta quebrada com cliente dentro sumiu
 * da contagem de danificadas por seis semanas).
 *
 * O preço está medido e é o teto: com 200 caixas de 8 a 16 posições, são 1.600
 * a 3.200 linhas de porta por consulta. No pior caso teórico — 200 caixas de
 * 256 —, 51.200. Se algum dia isso pesar, a saída é o `GROUP BY` **com teste de
 * consistência contra esta função**, e não uma reescrita silenciosa.
 */

/**
 * Teto de marcadores por resposta.
 *
 * Não é otimização prematura: é a diferença entre um mapa que abre e um que
 * trava (PRD §200). E é **informado**, nunca silencioso — um mapa que corta em
 * 200 sem dizer nada faz o despachante concluir que a região tem 200 caixas.
 *
 * 200 porque acima disso a tela já pede agrupamento para ser legível, e o
 * agrupamento é `CTO-3.2`. O cliente pode pedir menos; **nunca mais**.
 */
export const CTO_MAP_MAX_MARKERS = 200;

export interface BoundingBox {
  north: number;
  south: number;
  east: number;
  west: number;
}

export type CtoMapStatus = "INACTIVE" | "DAMAGED" | "FULL" | "AVAILABLE";

/**
 * O que um marcador precisa, e nada além disso.
 *
 * **Sem cliente, sem vínculo, sem histórico, sem `serviceOrderId`, sem foto,
 * sem observação administrativa.** Um mapa é a superfície mais fácil de vazar
 * dado sem querer: ele existe para mostrar muitos registros de uma vez, e cada
 * campo a mais é multiplicado por duzentos.
 *
 * `latitude`/`longitude` saem como **número**, e não como o `Decimal` do
 * Prisma: quem consome é um mapa, e serializar `Decimal` produziria string que
 * a biblioteca teria de converter de volta.
 */
export interface CtoMapMarker {
  id: string;
  name: string;
  code: string | null;
  latitude: number;
  longitude: number;
  active: boolean;
  status: CtoMapStatus;
  summary: PublicCtoDetail["summary"];
}

export interface CtoMapView {
  markers: CtoMapMarker[];
  /**
   * A resposta bateu no teto? (PRD §200)
   *
   * `true` significa *"há mais caixas nesta área do que estas"* — e a tela
   * precisa dizer isso, senão quem olha conclui que viu tudo.
   */
  truncated: boolean;
  limit: number;
  /**
   * Caixas da empresa **sem coordenada**, contadas fora do recorte.
   *
   * Deliberadamente NÃO é do `bbox`: uma caixa sem coordenada não está em
   * região nenhuma, e enfiá-la num recorte exigiria inventar um ponto. O mapa
   * usa este número para oferecer a coleção "sem localização" em vez de
   * simplesmente esconder o que não sabe posicionar.
   */
  missingLocationCount: number;
}

// ---------------------------------------------------------------------------
// Bounding box
// ---------------------------------------------------------------------------

function finite(valor: unknown, campo: string): number {
  if (typeof valor !== "number" || !Number.isFinite(valor)) {
    throw badRequest(`O valor de ${campo} é inválido.`);
  }
  return valor;
}

/**
 * Valida o recorte visível.
 *
 * **`coordenadaValida` não é reutilizada aqui, e a diferença é real.** Aquela
 * regra recusa `0,0` porque, num PONTO, a ilha nula quase sempre significa
 * "campo não preenchido". A borda de um retângulo é outra coisa: um mapa
 * centrado no golfo da Guiné tem `0` num dos lados de forma perfeitamente
 * legítima.
 */
export function assertBoundingBox(raw: {
  north: unknown;
  south: unknown;
  east: unknown;
  west: unknown;
}): BoundingBox {
  const north = finite(raw.north, "north");
  const south = finite(raw.south, "south");
  const east = finite(raw.east, "east");
  const west = finite(raw.west, "west");

  for (const [nome, valor] of [
    ["north", north],
    ["south", south],
  ] as const) {
    if (valor < -90 || valor > 90) {
      throw badRequest(`A latitude de ${nome} deve estar entre -90 e 90.`);
    }
  }
  for (const [nome, valor] of [
    ["east", east],
    ["west", west],
  ] as const) {
    if (valor < -180 || valor > 180) {
      throw badRequest(`A longitude de ${nome} deve estar entre -180 e 180.`);
    }
  }

  if (north < south) {
    throw badRequest("O limite norte não pode ser menor que o sul.");
  }

  /*
    Recorte que cruza o antimeridiano é RECUSADO, não tratado.

    Tratá-lo custa uma consulta em duas faixas (`lng >= west OR lng <= east`), e
    o AlfaOS não tem para quem: uma rede de distribuição é local, e nenhuma
    empresa tem caixas dos dois lados da linha de data. Implementar por
    precaução seria complexidade sem teste real por trás.

    Recusar é melhor que devolver vazio: um `200` com lista vazia faria o mapa
    concluir que não há caixas na região, que é exatamente a leitura errada.
    Se um dia isso for preciso, é uma extensão decidida — não um resultado que
    já vinha errado em silêncio.
  */
  if (west > east) {
    throw badRequest(
      "Este recorte cruza o antimeridiano, e o mapa ainda não oferece isso.",
    );
  }

  return { north, south, east, west };
}

// ---------------------------------------------------------------------------
// Status derivado
// ---------------------------------------------------------------------------

/**
 * O estado do marcador, **derivado sempre**.
 *
 * Não existe `cto.mapStatus` e não deve existir: seria um segundo lugar que
 * precisa concordar com as portas, e o primeiro a divergir seria o que ninguém
 * revisou — a mesma razão pela qual `OCCUPIED` nunca virou coluna.
 *
 * Precedência aprovada, e cada degrau responde uma pergunta diferente:
 *
 * ```text
 * INACTIVE   a caixa saiu de operação        → nem se pergunta o resto
 * DAMAGED    tem posição com defeito         → alguém precisa ir lá
 * FULL       está inteira, e não cabe mais   → não adianta mandar instalação
 * AVAILABLE  cabe cliente novo
 * ```
 *
 * `DAMAGED` vem antes de `FULL` de propósito: uma caixa lotada é uma
 * informação de capacidade, e uma caixa com defeito é uma informação de
 * manutenção — e manutenção é o que faz alguém se deslocar.
 *
 * Só posições **dentro da capacidade** contam. Uma porta histórica danificada
 * não põe a caixa em manutenção: ela já não é ofertada.
 */
export function deriveCtoMapStatus(
  active: boolean,
  summary: PublicCtoDetail["summary"],
): CtoMapStatus {
  if (!active) return "INACTIVE";
  if (summary.damaged > 0) return "DAMAGED";
  if (summary.free === 0) return "FULL";
  return "AVAILABLE";
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

interface PortRow {
  id: string;
  ctoId: string;
  number: number;
  administrativeState: CtoPortAdministrativeState;
}

/**
 * As caixas visíveis no recorte, com o resumo operacional de cada uma.
 *
 * ## Três consultas, e o número não cresce com a quantidade de caixas
 *
 * ```text
 * 1  as CTOs do recorte     (tenant + bbox + teto, tudo no banco)
 * 2  as portas delas        (um IN, não uma consulta por caixa)
 * 3  os vínculos ativos     (um IN, idem)
 * +  a contagem de caixas sem coordenada
 * ```
 *
 * O `N+1` desta superfície seria fatal de um jeito específico: não é uma tela
 * que abre devagar, é um mapa que dispara uma rajada a cada arrasto do mouse.
 *
 * ## O recorte é do BANCO, nunca do JavaScript
 *
 * Filtrar depois de buscar exigiria trazer a carteira inteira antes — o oposto
 * do objetivo, e um vazamento de tenant esperando acontecer (PRD §200). O
 * `companyId` e o retângulo entram no mesmo `where`.
 *
 * ## Ocupação continua derivada do vínculo
 *
 * `CTOPort.administrativeState` **não** é fonte de ocupação. Uma porta ocupada
 * continua `AVAILABLE` no eixo administrativo, e quem responde "tem alguém
 * ligado?" é a existência de `CustomerNetworkConnection` sem `disconnectedAt`.
 * Trocar isso aqui reintroduziria a segunda fonte de verdade que a `CTO-2`
 * recusou desde o congelamento.
 */
export async function getCtoMapView(
  companyId: string,
  options: { bbox: BoundingBox; limit?: number },
): Promise<CtoMapView> {
  const limit = Math.min(
    Math.max(options.limit ?? CTO_MAP_MAX_MARKERS, 1),
    CTO_MAP_MAX_MARKERS,
  );
  const { north, south, east, west } = options.bbox;

  /*
    Busca `limit + 1` para saber se cortou.

    Um `count` separado responderia a mesma pergunta com uma consulta a mais, e
    a única coisa que o mapa precisa saber é "tem mais?" — não "quantas mais".
  */
  const ctos = await prisma.cTO.findMany({
    where: {
      // Tenant no predicado SQL, junto com o recorte. Nunca depois, em memória.
      companyId,
      latitude: { gte: south, lte: north },
      longitude: { gte: west, lte: east },
    },
    select: {
      id: true,
      name: true,
      code: true,
      latitude: true,
      longitude: true,
      active: true,
      capacity: true,
    },
    orderBy: [{ name: "asc" }],
    take: limit + 1,
  });

  const truncated = ctos.length > limit;
  const visiveis = truncated ? ctos.slice(0, limit) : ctos;

  const missingLocationCount = await prisma.cTO.count({
    // `null` em QUALQUER dos dois eixos: meia coordenada não posiciona nada.
    where: {
      companyId,
      OR: [{ latitude: null }, { longitude: null }],
    },
  });

  if (visiveis.length === 0) {
    return { markers: [], truncated, limit, missingLocationCount };
  }

  const ids = visiveis.map((c) => c.id);

  const [portas, ocupadas] = await Promise.all([
    prisma.cTOPort.findMany({
      where: { companyId, ctoId: { in: ids } },
      select: {
        id: true,
        ctoId: true,
        number: true,
        administrativeState: true,
      },
    }),
    prisma.customerNetworkConnection.findMany({
      where: {
        companyId,
        disconnectedAt: null,
        ctoPort: { ctoId: { in: ids } },
      },
      select: { ctoPortId: true },
    }),
  ]);

  const ocupadosPorId = new Set(ocupadas.map((o) => o.ctoPortId));
  const porCto = new Map<string, PortRow[]>();
  for (const porta of portas) {
    const lista = porCto.get(porta.ctoId);
    if (lista) lista.push(porta);
    else porCto.set(porta.ctoId, [porta]);
  }

  return {
    markers: visiveis.map((cto) => {
      const summary = summarizePortCounts(
        (porCto.get(cto.id) ?? []).map((porta) => ({
          administrativeState: porta.administrativeState,
          withinCapacity: isPortWithinCapacity(porta, cto.capacity),
          occupied: ocupadosPorId.has(porta.id),
        })),
        cto.capacity,
      );
      return {
        id: cto.id,
        name: cto.name,
        code: cto.code,
        /*
          Só entram caixas COM coordenada — o `where` já garante —, então o
          `Number` aqui nunca recebe `null`. Uma caixa sem posição não vira
          marcador em `0,0`: ela é contada à parte.
        */
        latitude: Number(cto.latitude),
        longitude: Number(cto.longitude),
        active: cto.active,
        status: deriveCtoMapStatus(cto.active, summary),
        summary,
      };
    }),
    truncated,
    limit,
    missingLocationCount,
  };
}
