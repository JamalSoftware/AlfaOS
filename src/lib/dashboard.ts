import { AccessProfile } from "@prisma/client";
import { countCtoAttention, getCompanyCtoStates } from "./cto-attention";
import { getCompanyConnectivityStatuses } from "./customer-diagnostics";
import { countCompanyCustomers } from "./customers";
import { prisma } from "./prisma";
import { countCompanyServiceOrders } from "./service-orders";
import type { SliceClock } from "./service-order-slices";
import { countCompanyTechnicians } from "./technicians";
import { resolveTimezone } from "./workday";

/**
 * # O painel operacional — DASH-1 (PRD §380, MASTER-PLAN §4)
 *
 * Responde uma pergunta só: **o que está acontecendo agora, e o que precisa da
 * minha atenção?** Não é o módulo Analytics (PRD §410): nada de histórico,
 * série temporal, ranking ou previsão. É o estado operacional do momento.
 *
 * ## Todo número é o da tela de destino
 *
 * Cada cartão abre uma listagem filtrada, e a contagem do cartão tem de bater
 * com a da listagem — é essa igualdade que impede o painel de virar decoração.
 * Por isso nenhum número é calculado aqui: cada um vem da função `count…` do
 * próprio módulo da listagem, com o MESMO filtro que o link do cartão leva.
 *
 * ```text
 * OS abertas            countCompanyServiceOrders({ slice: "abertas" })
 * OS atrasadas          countCompanyServiceOrders({ slice: "atrasadas" })
 * OS de hoje            countCompanyServiceOrders({ slice: "hoje" })
 * OS pendentes          countCompanyServiceOrders({ status: "PENDING" })
 * Técnicos em atend.    countCompanyTechnicians({ inService: true })
 * Clientes offline      countCompanyCustomers({ active, connectivity: OFFLINE })
 * CTOs com defeito      getCompanyCtoStates → estado DAMAGED
 * CTOs com OS abertas   getCompanyCtoStates → OS abertas > 0
 * ```
 *
 * ## Quem vê o quê
 *
 * O PRD não separa visões por perfil, e a regra é preservar o acesso que já
 * existe — nunca ampliá-lo por causa de um painel:
 *
 * - **OS e equipe**: `ADMIN` e `DISPATCHER`, que já leem as duas listagens.
 * - **Clientes offline**: `ADMIN`. A conectividade da carteira inteira é
 *   `ADMIN` no mapa (camada de clientes, resumo por CTO — §376).
 * - **CTOs**: `ADMIN` e só com a capability de rede ligada. `/ctos` é `ADMIN`,
 *   e um cartão sem destino violaria o próprio §380.
 *
 * ## Zero é dado; erro é erro
 *
 * Cada seção falha sozinha e chega à tela como `error`, nunca como `0`. Um
 * painel que mostrasse "0 OS atrasadas" porque a consulta caiu diria o
 * contrário do que é verdade, com a mesma cara de um dia tranquilo.
 */

export interface DashboardRecentActivity {
  id: string;
  action: string;
  entity: string | null;
  entityId: string | null;
  userName: string | null;
  createdAt: Date;
}

export type DashboardSection<T> =
  | { state: "ok"; data: T }
  | { state: "error" }
  | { state: "hidden" };

export interface DashboardServiceOrders {
  abertas: number;
  atrasadas: number;
  hoje: number;
  pendentes: number;
}

export interface DashboardTeam {
  emAtendimento: number;
}

export interface DashboardCustomers {
  /** O número do cartão — o mesmo da `/clientes?active=true&conectividade=OFFLINE`. */
  offline: number;
  /**
   * Clientes ativos cuja última leitura afirma ONLINE ou OFFLINE. Zero aqui
   * significa que a autoridade da §370 ainda não consegue responder, e a tela
   * mostra "sem leitura" em vez de "0 offline".
   */
  comLeitura: number;
  ativos: number;
}

export interface DashboardCtos {
  comDefeito: number;
  comOsAbertas: number;
}

export interface OperationalDashboard {
  generatedAt: Date;
  timezone: string;
  serviceOrders: DashboardSection<DashboardServiceOrders>;
  team: DashboardSection<DashboardTeam>;
  customers: DashboardSection<DashboardCustomers>;
  ctos: DashboardSection<DashboardCtos>;
  recentActivity: DashboardSection<DashboardRecentActivity[]>;
}

export interface DashboardViewer {
  companyId: string;
  profile: AccessProfile;
}

async function secao<T>(
  nome: string,
  companyId: string,
  ler: () => Promise<T>,
): Promise<DashboardSection<T>> {
  try {
    return { state: "ok", data: await ler() };
  } catch (error) {
    // Só o nome da seção e o tipo do erro: mensagem de banco pode trazer
    // fragmento de consulta, e isto vai para log de servidor.
    console.error(
      `[dashboard] seção "${nome}" falhou`,
      { companyId, erro: error instanceof Error ? error.name : "desconhecido" },
    );
    return { state: "error" };
  }
}

export async function getOperationalDashboard(
  viewer: DashboardViewer,
  now: Date = new Date(),
): Promise<OperationalDashboard> {
  const { companyId } = viewer;
  const isAdmin = viewer.profile === AccessProfile.ADMIN;

  /*
    Uma leitura da empresa serve às duas perguntas que dependem dela: o fuso
    (para "hoje" e "atrasadas") e a capability de rede (para os cartões de CTO).
    As seções que precisam dela a aguardam dentro do próprio `secao`, então uma
    falha aqui vira erro NESSAS seções, e não um painel inteiro em branco.
  */
  const empresa = prisma.company.findUnique({
    where: { id: companyId },
    select: { timezone: true, ctoNetworkEnabled: true },
  });
  // A promessa é consumida por várias seções; sem este `catch`, uma rejeição
  // lida só depois poderia ser reportada como "não tratada" pelo Node.
  empresa.catch(() => undefined);

  const relogio = async (): Promise<SliceClock> => ({
    now,
    timezone: resolveTimezone((await empresa)?.timezone),
  });

  /*
    CTOs: `ADMIN` e capability ligada. Com a capability desligada a seção é
    `hidden` — e não um cartão com zero: um "0 CTOs com defeito" anunciaria à
    empresa um módulo que ela não contratou, o mesmo motivo pelo qual `/ctos`
    responde 404 nesse caso.
  */
  const secaoDeCtos = async (): Promise<DashboardSection<DashboardCtos>> => {
    if (!isAdmin) return { state: "hidden" };
    let habilitada: boolean;
    try {
      habilitada = (await empresa)?.ctoNetworkEnabled === true;
    } catch {
      return { state: "error" };
    }
    if (!habilitada) return { state: "hidden" };
    return secao("ctos", companyId, async () => {
      const contagem = countCtoAttention(await getCompanyCtoStates(companyId));
      return {
        comDefeito: contagem.defeito,
        comOsAbertas: contagem["com-os-abertas"],
      };
    });
  };

  const [serviceOrders, team, customers, ctos, recentActivity, timezone] =
    await Promise.all([
      secao("ordens", companyId, async () => {
        const clock = await relogio();
        const [abertas, atrasadas, hoje, pendentes] = await Promise.all([
          countCompanyServiceOrders(companyId, { slice: "abertas", clock }),
          countCompanyServiceOrders(companyId, { slice: "atrasadas", clock }),
          countCompanyServiceOrders(companyId, { slice: "hoje", clock }),
          countCompanyServiceOrders(companyId, { status: "PENDING" }),
        ]);
        return { abertas, atrasadas, hoje, pendentes };
      }),

      secao("equipe", companyId, async () => ({
        emAtendimento: await countCompanyTechnicians(companyId, {
          inService: true,
        }),
      })),

      isAdmin
        ? secao("clientes", companyId, async () => {
            const [offline, estados, ativos] = await Promise.all([
              countCompanyCustomers(companyId, {
                active: true,
                connectivity: "OFFLINE",
              }),
              getCompanyConnectivityStatuses(companyId, {
                activeCustomersOnly: true,
              }),
              prisma.customer.count({ where: { companyId, active: true } }),
            ]);
            let comLeitura = 0;
            for (const status of Array.from(estados.values())) {
              if (status === "ONLINE" || status === "OFFLINE") comLeitura += 1;
            }
            return { offline, comLeitura, ativos };
          })
        : Promise.resolve<DashboardSection<DashboardCustomers>>({
            state: "hidden",
          }),

      secaoDeCtos(),

      secao("atividade", companyId, async () => {
        const logs = await prisma.auditLog.findMany({
          where: { companyId },
          orderBy: { createdAt: "desc" },
          take: 10,
          include: { user: { select: { name: true } } },
        });
        return logs.map((log) => ({
          id: log.id,
          action: log.action,
          entity: log.entity,
          entityId: log.entityId,
          userName: log.user?.name ?? null,
          createdAt: log.createdAt,
        }));
      }),

      empresa
        .then((e) => resolveTimezone(e?.timezone))
        .catch(() => resolveTimezone(null)),
    ]);

  return {
    generatedAt: now,
    timezone,
    serviceOrders,
    team,
    customers,
    ctos,
    recentActivity,
  };
}
