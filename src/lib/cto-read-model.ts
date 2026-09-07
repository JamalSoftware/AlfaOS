import {
  effectivePortState,
  getCto,
  type PublicCtoDetail,
  type PublicCtoPort,
} from "./cto";
import type { PublicNetworkConnection } from "./cto-connections";
import { prisma } from "./prisma";

/**
 * # `CTO-2.2` — o read model operacional da caixa
 *
 * A `CTO-1` respondia *"que estado administrativo cada posição tem?"*. Com o
 * vínculo existindo, a caixa passa a ter **duas** perguntas, e elas não são a
 * mesma:
 *
 * ```text
 * administrativeState   esta posição pode receber alguém?
 * occupied              tem alguém aqui agora?
 * ```
 *
 * ## Por que este módulo existe separado
 *
 * `cto-connections.ts` importa `cto.ts` (para `isPortOfferable`). Se `cto.ts`
 * passasse a importar o vínculo para calcular ocupação, o ciclo estaria
 * fechado. Aqui em cima os dois são consumidos sem que nenhum conheça o outro,
 * e `getCto` — publicado na `v0.14` — continua exatamente como estava.
 */

/** Uma porta, com as duas dimensões separadas. */
export interface OperationalCtoPort extends PublicCtoPort {
  /** `number <= capacity`. Explícito no DTO: a tela não deve recalcular. */
  withinCapacity: boolean;
  /** Existe vínculo ativo. Derivado, nunca uma coluna. */
  occupied: boolean;
  /**
   * Atalho da tela para "esta porta é candidata a receber alguém?".
   *
   * **É ADVISORY, e só.** A transação de escrita revalida CTO ativa, faixa,
   * estado e ocupação com a caixa travada. Um cliente que confiasse neste
   * booleano para autorizar estaria decidindo com uma fotografia — e é
   * exatamente por isso que ele nunca substitui a checagem do domínio.
   */
  availableForConnection: boolean;
  /** Quem está na porta agora, quando há alguém. */
  activeConnection: OperationalPortConnection | null;
}

/** O ocupante, no mínimo que a operação precisa para agir. */
export interface OperationalPortConnection {
  id: string;
  connectedAt: Date;
  customer: { id: string; name: string };
}

export interface OperationalCtoDetail extends Omit<PublicCtoDetail, "ports"> {
  ports: OperationalCtoPort[];
}

/**
 * O resumo, recontado sobre as DUAS dimensões.
 *
 * ## O defeito que isto corrige
 *
 * A `CTO-1` contava tudo a partir de `effectiveState`, que colapsa em
 * `OCCUPIED` sempre que há vínculo. Enquanto não havia vínculo nenhum, a conta
 * acertava — por coincidência. Ligada a ocupação real, uma porta `DAMAGED` com
 * cliente dentro **sairia** da contagem de danificadas: o resumo diria
 * `damaged: 0` com uma posição quebrada e alguém nela.
 *
 * ```text
 * damaged   administrativeState = DAMAGED     (ocupada ou não)
 * reserved  administrativeState = RESERVED    (ocupada ou não)
 * occupied  existe vínculo ativo
 * free      AVAILABLE E sem vínculo ativo
 * ```
 *
 * ## As categorias SE SOBREPÕEM, e isso é correto
 *
 * `free + reserved + damaged + occupied` pode ser **maior** que `capacity`,
 * porque uma porta pode ser danificada **e** ocupada ao mesmo tempo. Não existe
 * invariante de soma, e uma tela que apresente as quatro como fatias de um todo
 * estará errada a partir daqui.
 */
function summarize(
  ports: OperationalCtoPort[],
  capacity: number,
): PublicCtoDetail["summary"] {
  const inRange = ports.filter((p) => p.withinCapacity);
  return {
    capacity,
    free: inRange.filter(
      (p) => p.administrativeState === "AVAILABLE" && !p.occupied,
    ).length,
    occupied: inRange.filter((p) => p.occupied).length,
    reserved: inRange.filter((p) => p.administrativeState === "RESERVED").length,
    damaged: inRange.filter((p) => p.administrativeState === "DAMAGED").length,
    historical: ports.filter((p) => !p.withinCapacity).length,
  };
}

/**
 * O detalhe da caixa com ocupação real.
 *
 * **Uma consulta para a caixa inteira**, e não uma por porta. Uma CTO pode ter
 * 256 posições, e perguntar porta a porta seria o `N+1` clássico — 257
 * requisições para montar uma tela. O predicado é por `ctoId`, e o tenant entra
 * nele.
 */
export async function getOperationalCtoDetail(
  companyId: string,
  ctoId: string,
): Promise<OperationalCtoDetail | null> {
  const cto = await getCto(companyId, ctoId);
  if (!cto) return null;

  const ativos = await prisma.customerNetworkConnection.findMany({
    where: { companyId, disconnectedAt: null, ctoPort: { ctoId } },
    select: {
      id: true,
      ctoPortId: true,
      connectedAt: true,
      customer: { select: { id: true, name: true } },
    },
  });

  /*
    O banco garante no máximo um vínculo ativo por porta (índice único
    parcial). O mapa reflete isso: se dois chegassem aqui, o segundo
    sobrescreveria o primeiro em silêncio — então a conferência abaixo existe
    para que corrupção apareça em vez de virar "algum" ocupante.
  */
  const porPorta = new Map<string, (typeof ativos)[number]>();
  for (const a of ativos) {
    if (porPorta.has(a.ctoPortId)) {
      throw new Error(
        "Invariante violada: mais de um vínculo ativo na mesma porta.",
      );
    }
    porPorta.set(a.ctoPortId, a);
  }

  const ports: OperationalCtoPort[] = cto.ports.map((p) => {
    const ativo = porPorta.get(p.id) ?? null;
    const withinCapacity = p.number <= cto.capacity;
    const occupied = ativo !== null;
    return {
      ...p,
      /*
        `effectiveState` é RECALCULADO com a ocupação real.

        `getCto` o produziu com `hasActiveConnection = false`, porque a `CTO-1`
        não conhecia vínculo — e o valor dela sobreviveria ao `spread` sem que
        nada acusasse. O rótulo tem de vir da mesma verdade que `occupied`,
        senão a tela mostra "Livre" numa porta com cliente dentro.
      */
      effectiveState: effectivePortState(p.administrativeState, occupied),
      withinCapacity,
      occupied,
      /*
        Candidata exige as TRÊS coisas, e a CTO ativa é uma delas: uma caixa
        desativada continua legível e continua deixando desconectar e mover
        para fora — só não recebe ninguém novo.
      */
      availableForConnection:
        cto.active &&
        withinCapacity &&
        p.administrativeState === "AVAILABLE" &&
        !occupied,
      activeConnection: ativo
        ? {
            id: ativo.id,
            connectedAt: ativo.connectedAt,
            customer: ativo.customer,
          }
        : null,
    };
  });

  return { ...cto, ports, summary: summarize(ports, cto.capacity) };
}

// ---------------------------------------------------------------------------
// A visão do cliente
// ---------------------------------------------------------------------------

export interface CustomerNetworkView {
  /** Onde o cliente está agora, ou `null`. */
  current: CustomerNetworkPlacement | null;
  /** Onde já esteve, do mais recente para o mais antigo. */
  history: CustomerNetworkPlacement[];
}

export interface CustomerNetworkPlacement {
  connectionId: string;
  cto: { id: string; name: string; active: boolean };
  port: { id: string; number: number };
  connectedAt: Date;
  disconnectedAt: Date | null;
  source: PublicNetworkConnection["source"];
  reason: string | null;
}

/**
 * Onde o cliente está, e onde esteve.
 *
 * **Sem `customer.ctoId`.** A pergunta "onde este cliente está" é respondida
 * pelo vínculo ativo, e uma coluna no cliente seria a segunda memória do mesmo
 * fato — a que fica errada quando a movimentação falha no meio.
 *
 * Uma consulta só traz corrente e histórico: a linha ativa é a que tem
 * `disconnectedAt` nulo, e separá-las em duas idas ao banco só produziria a
 * chance de as duas discordarem.
 */
export async function getCustomerNetworkView(
  companyId: string,
  customerId: string,
): Promise<CustomerNetworkView> {
  const linhas = await prisma.customerNetworkConnection.findMany({
    where: { companyId, customerId },
    select: {
      id: true,
      connectedAt: true,
      disconnectedAt: true,
      source: true,
      reason: true,
      ctoPort: {
        select: {
          id: true,
          number: true,
          cto: { select: { id: true, name: true, active: true } },
        },
      },
    },
    orderBy: { connectedAt: "desc" },
  });

  const placements: CustomerNetworkPlacement[] = linhas.map((l) => ({
    connectionId: l.id,
    cto: l.ctoPort.cto,
    port: { id: l.ctoPort.id, number: l.ctoPort.number },
    connectedAt: l.connectedAt,
    disconnectedAt: l.disconnectedAt,
    source: l.source,
    reason: l.reason,
  }));

  /*
    O banco garante no máximo um ativo por cliente. Se mais de um aparecer, a
    resposta NÃO é escolher o primeiro: escolher silenciosamente esconderia a
    corrupção atrás de uma tela que parece normal, e a operação agiria sobre uma
    linha arbitrária.
  */
  const ativos = placements.filter((p) => p.disconnectedAt === null);
  if (ativos.length > 1) {
    throw new Error(
      "Invariante violada: cliente com mais de um vínculo ativo.",
    );
  }

  return { current: ativos[0] ?? null, history: placements };
}
