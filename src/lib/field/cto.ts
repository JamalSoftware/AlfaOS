import type { CtoPortAdministrativeState } from "@prisma/client";
import { isCtoNetworkEnabled, isPortWithinCapacity } from "@/lib/cto";
import {
  connectCustomerToPort,
  disconnectCustomer,
  moveCustomerToPort,
  type ConnectionContext,
  type MoveResult,
  type PublicNetworkConnection,
} from "@/lib/cto-connections";
import { prisma } from "@/lib/prisma";
import {
  claimOrderForChildMutation,
  loadInProgressOwnedOrder,
} from "@/lib/service-order-child-mutation";
import type { FieldPrincipal, FieldTx } from "./auth";
import { FieldError } from "./errors";
import { resolveOwnedOrderCustomer } from "./service-orders";

/**
 * # A rede de distribuição vista do campo
 *
 * O técnico opera a CTO **através da OS**, e nunca fora dela. Este módulo é a
 * fronteira que traduz isso: autentica pela OS, projeta o que o aparelho pode
 * ver e monta a procedência `FIELD` que o domínio da `CTO-2.1` exige.
 *
 * **Nenhuma regra de negócio vive aqui.** Ocupação, faixa de capacidade,
 * ofertabilidade, CTO inativa, unicidade de porta e de cliente continuam sendo
 * decididas por `src/lib/cto-connections.ts`, dentro da transação. Reimplementar
 * qualquer uma delas para o Field criaria duas verdades, e a segunda a divergir
 * seria a que ninguém revisou.
 *
 * ## O que o Field NÃO recebe
 *
 * A projeção omite o ocupante de qualquer porta que não seja a do cliente da
 * OS. Uma caixa de 16 posições costuma ter 15 clientes de outras pessoas, e
 * `occupied: true` responde a pergunta operacional inteira — *posso usar esta
 * porta?* — sem entregar o nome de quem não tem nada com este atendimento.
 *
 * Também não saem: `companyId`, o `serviceOrderId` e o `technicianId` de
 * vínculos alheios, coordenadas da caixa, foto, observações administrativas e
 * qualquer coisa de PPPoE. A senha do cliente tem uma porta própria, explícita
 * e auditada, e nada aqui a atravessa.
 */

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

/**
 * A empresa contratou o módulo de rede?
 *
 * Desligada, a superfície inteira responde `NOT_FOUND` — nunca `FORBIDDEN`. A
 * diferença é a mesma que a `CTO-1` fixou na web: um `403` diria *isto existe,
 * você é que não pode*, e a empresa descobriria pela mensagem de erro que há um
 * módulo que ela não contratou.
 */
export async function assertFieldCtoEnabled(
  principal: FieldPrincipal,
): Promise<void> {
  if (!(await isCtoNetworkEnabled(principal.user.companyId))) {
    throw new FieldError("NOT_FOUND", "Recurso não encontrado.");
  }
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/**
 * Uma posição da caixa, com as **duas** dimensões separadas.
 *
 * `effectiveState` não existe aqui de propósito. Ele colapsa em `OCCUPIED` e
 * apagaria `DAMAGED` de uma porta com cliente dentro — que é exatamente a
 * informação que fez alguém marcá-la, e exatamente o defeito que a `CTO-2.2`
 * corrigiu no resumo administrativo. O aplicativo recebe as duas e decide o
 * rótulo.
 */
export interface FieldNetworkPort {
  id: string;
  number: number;
  administrativeState: CtoPortAdministrativeState;
  occupied: boolean;
  /** Advisory. Quem decide é a transação da escrita. */
  availableForConnection: boolean;
}

export interface FieldNetworkCto {
  id: string;
  name: string;
  code: string | null;
  active: boolean;
}

/** Onde o cliente da OS está agora. */
export interface FieldNetworkPlacement {
  connectionId: string;
  cto: FieldNetworkCto;
  port: FieldNetworkPort;
  connectedAt: string;
}

export interface FieldOrderNetwork {
  connection: FieldNetworkPlacement | null;
}

export interface FieldCandidateCto extends FieldNetworkCto {
  capacity: number;
  /** Portas ofertáveis agora: dentro da faixa, `AVAILABLE` e livres. */
  availablePorts: number;
}

export interface FieldCandidateCtoDetail extends FieldCandidateCto {
  ports: FieldNetworkPort[];
}

// ---------------------------------------------------------------------------
// Projeção
// ---------------------------------------------------------------------------

interface PortRow {
  id: string;
  number: number;
  administrativeState: CtoPortAdministrativeState;
}

function toPort(
  port: PortRow,
  capacity: number,
  ctoActive: boolean,
  occupied: boolean,
): FieldNetworkPort {
  return {
    id: port.id,
    number: port.number,
    administrativeState: port.administrativeState,
    occupied,
    availableForConnection:
      ctoActive &&
      isPortWithinCapacity(port, capacity) &&
      port.administrativeState === "AVAILABLE" &&
      !occupied,
  };
}

// ---------------------------------------------------------------------------
// Leitura — o vínculo atual do cliente da OS
// ---------------------------------------------------------------------------

/**
 * O vínculo do cliente **da OS**, resolvido a partir da própria OS.
 *
 * `customerId` não é parâmetro e não é aceito de lugar nenhum: quem determina o
 * cliente é a ordem de serviço. É o que fecha o vetor mais barato desta
 * superfície — OS legítima do próprio técnico usada para olhar outro cliente.
 */
export async function getFieldOrderNetwork(
  companyId: string,
  technicianId: string,
  orderId: string,
): Promise<FieldOrderNetwork> {
  const { customerId } = await resolveOwnedOrderCustomer(
    companyId,
    technicianId,
    orderId,
    { requireInProgress: true },
  );

  const active = await prisma.customerNetworkConnection.findFirst({
    // Tenant no predicado SQL, nunca por navegação de FK.
    where: { companyId, customerId, disconnectedAt: null },
    select: {
      id: true,
      connectedAt: true,
      ctoPort: {
        select: {
          id: true,
          number: true,
          administrativeState: true,
          cto: {
            select: {
              id: true,
              name: true,
              code: true,
              active: true,
              capacity: true,
            },
          },
        },
      },
    },
  });

  if (!active) return { connection: null };

  const cto = active.ctoPort.cto;
  return {
    connection: {
      connectionId: active.id,
      cto: { id: cto.id, name: cto.name, code: cto.code, active: cto.active },
      /*
        `occupied: true` sem consultar de novo: a porta é a DESTE vínculo, que
        está aberto. Perguntar ao banco devolveria a linha que já está na mão.
      */
      port: toPort(active.ctoPort, cto.capacity, cto.active, true),
      connectedAt: active.connectedAt.toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Leitura — candidatas
// ---------------------------------------------------------------------------

export const FIELD_CTO_PAGE_SIZE = 20;
export const FIELD_CTO_MAX_PAGE_SIZE = 50;

/**
 * As caixas que podem receber o cliente, com quantas posições livres cada uma
 * tem.
 *
 * **Sem portas no corpo.** Uma caixa chega a 256 posições e o teto da página é
 * 50 caixas: devolver as portas de todas produziria uma resposta de milhares de
 * linhas para uma tela que precisa de uma. O técnico acha a caixa e depois pede
 * as portas dela, que é como ele trabalha no poste.
 *
 * **Sem `N+1`.** A ocupação da página inteira sai de UMA consulta, e não de uma
 * por caixa nem de uma por porta.
 *
 * Só CTO **ativa**: uma caixa desativada não recebe ninguém novo, e listá-la
 * como candidata só produziria um `409` depois da subida no poste.
 */
export async function listFieldCandidateCtos(
  companyId: string,
  options: { search?: string | null; limit?: number } = {},
): Promise<FieldCandidateCto[]> {
  const limit = Math.min(
    Math.max(options.limit ?? FIELD_CTO_PAGE_SIZE, 1),
    FIELD_CTO_MAX_PAGE_SIZE,
  );
  const search = options.search?.trim();

  const ctos = await prisma.cTO.findMany({
    where: {
      companyId,
      active: true,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" as const } },
              { code: { contains: search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    select: { id: true, name: true, code: true, active: true, capacity: true },
    orderBy: [{ name: "asc" }],
    take: limit,
  });

  if (ctos.length === 0) return [];

  const ids = ctos.map((c) => c.id);

  const [ports, occupied] = await Promise.all([
    prisma.cTOPort.findMany({
      where: { companyId, ctoId: { in: ids }, administrativeState: "AVAILABLE" },
      select: { id: true, ctoId: true, number: true },
    }),
    prisma.customerNetworkConnection.findMany({
      where: { companyId, disconnectedAt: null, ctoPort: { ctoId: { in: ids } } },
      select: { ctoPortId: true },
    }),
  ]);

  const busy = new Set(occupied.map((o) => o.ctoPortId));
  const capacityOf = new Map(ctos.map((c) => [c.id, c.capacity]));
  const free = new Map<string, number>();
  for (const port of ports) {
    const capacity = capacityOf.get(port.ctoId);
    if (capacity === undefined) continue;
    if (!isPortWithinCapacity(port, capacity)) continue;
    if (busy.has(port.id)) continue;
    free.set(port.ctoId, (free.get(port.ctoId) ?? 0) + 1);
  }

  return ctos.map((c) => ({
    id: c.id,
    name: c.name,
    code: c.code,
    active: c.active,
    capacity: c.capacity,
    availablePorts: free.get(c.id) ?? 0,
  }));
}

/**
 * Uma caixa e as posições dela.
 *
 * Devolve **todas** as portas dentro da capacidade, ocupadas incluídas, porque
 * o técnico precisa entender a caixa que está abrindo: saber que a 5 está
 * danificada e a 6 tem gente evita subir de novo. O que não sai é QUEM está na
 * 6 — `occupied` responde a pergunta operacional sem entregar o cliente de
 * outro atendimento.
 *
 * Porta histórica (`number > capacity`) fica de fora: não é ofertável, e
 * exibi-la convidaria a escolher uma posição que a empresa declarou não existir
 * mais.
 */
export async function getFieldCandidateCto(
  companyId: string,
  ctoId: string,
): Promise<FieldCandidateCtoDetail | null> {
  const cto = await prisma.cTO.findFirst({
    where: { id: ctoId, companyId },
    select: { id: true, name: true, code: true, active: true, capacity: true },
  });
  if (!cto) return null;

  const [ports, occupied] = await Promise.all([
    prisma.cTOPort.findMany({
      where: { companyId, ctoId: cto.id },
      select: { id: true, number: true, administrativeState: true },
      orderBy: { number: "asc" },
    }),
    prisma.customerNetworkConnection.findMany({
      where: { companyId, disconnectedAt: null, ctoPort: { ctoId: cto.id } },
      select: { ctoPortId: true },
    }),
  ]);

  const busy = new Set(occupied.map((o) => o.ctoPortId));
  const visible = ports
    .filter((p) => isPortWithinCapacity(p, cto.capacity))
    .map((p) => toPort(p, cto.capacity, cto.active, busy.has(p.id)));

  return {
    id: cto.id,
    name: cto.name,
    code: cto.code,
    active: cto.active,
    capacity: cto.capacity,
    availablePorts: visible.filter((p) => p.availableForConnection).length,
    ports: visible,
  };
}

// ---------------------------------------------------------------------------
// Resultado das mutações
// ---------------------------------------------------------------------------

/**
 * O vínculo tal como a operação o deixou.
 *
 * **Sai da própria mutação, nunca de uma releitura depois do commit.** Reler
 * seria repetir o `START-01` da v0.9, em que a resposta consultava de novo a OS
 * e devolvia 404 quando ela era reatribuída no intervalo — a operação tinha dado
 * certo e o aparelho recebia um erro.
 *
 * `customerId`, `source`, `serviceOrderId` e `technicianId` existem na
 * projeção do domínio e **não** entram aqui: os quatro já são conhecidos pelo
 * aparelho, porque foram ele e a OS que os determinaram, e repeti-los só
 * ampliaria a superfície.
 */
export interface FieldConnectionResult {
  connectionId: string;
  ctoId: string;
  ctoPortId: string;
  portNumber: number;
  connectedAt: string;
  disconnectedAt: string | null;
}

/**
 * A forma **única** das três mutações.
 *
 * `connection` é o vínculo vigente depois da operação e `previous` o que ela
 * encerrou. Conectar preenche o primeiro, desconectar o segundo, mover os dois
 * — e uma forma só evita que o aplicativo tenha três leitores para o mesmo
 * assunto.
 */
export interface FieldConnectionMutation {
  connection: FieldConnectionResult | null;
  previous: FieldConnectionResult | null;
}

export function toFieldConnectionResult(
  connection: PublicNetworkConnection,
): FieldConnectionResult {
  return {
    connectionId: connection.id,
    ctoId: connection.ctoId,
    ctoPortId: connection.ctoPortId,
    portNumber: connection.portNumber,
    connectedAt: connection.connectedAt.toISOString(),
    disconnectedAt: connection.disconnectedAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Mutação — a procedência FIELD, montada depois da autorização
// ---------------------------------------------------------------------------

export interface FieldConnectionCommand {
  principal: FieldPrincipal;
  orderId: string;
  expectedVersion: number;
}

interface AuthorizedField {
  customerId: string;
  context: ConnectionContext;
}

/**
 * Resolve o cliente da OS e devolve o contexto `FIELD` já autorizado.
 *
 * A autorização acontece **duas vezes, e as duas contam**:
 *
 * 1. aqui fora, para descobrir o cliente e recusar cedo o que nunca vai passar;
 * 2. dentro da transação, por `authorizeWithin`, que é o que realmente decide.
 *
 * A de dentro não é redundância. Ela usa `loadInProgressOwnedOrder` — o mesmo
 * portão de evidência, material, equipamento, assinatura e checklist — e
 * `claimOrderForChildMutation`, cujo `UPDATE` segura a linha da OS até o commit.
 * Sem ela, a OS poderia ser concluída entre a conferência e a escrita, e o
 * evento de timeline nasceria depois do fechamento.
 *
 * A comparação `order.customerId !== customerId` é **defesa em profundidade**,
 * e não um vetor aberto: o cliente daqui saiu da mesma OS, e
 * `ServiceOrder.customerId` não tem caminho de alteração. Ela existe para que a
 * invariante *o cliente do vínculo é o cliente da OS* seja estrutural dentro do
 * lock, em vez de uma propriedade que só se prova lendo duas funções.
 */
async function authorizeFieldConnection(
  command: FieldConnectionCommand,
): Promise<AuthorizedField> {
  const { principal, orderId, expectedVersion } = command;
  const companyId = principal.user.companyId;

  const { customerId } = await resolveOwnedOrderCustomer(
    companyId,
    principal.technician.id,
    orderId,
    { requireInProgress: true },
  );

  return {
    customerId,
    context: {
      companyId,
      /*
        Tudo derivado do servidor. O corpo da requisição não tem — e os schemas
        `.strict()` das rotas não aceitam — `companyId`, `source`,
        `technicianId`, `serviceOrderId`, `customerId` nem carimbo de tempo.
      */
      provenance: {
        source: "FIELD",
        actorUserId: principal.user.id,
        technicianId: principal.technician.id,
        serviceOrderId: orderId,
      },
      authorizeWithin: async (tx: FieldTx) => {
        const { order } = await loadInProgressOwnedOrder(
          tx,
          companyId,
          principal.user.id,
          orderId,
        );
        if (order.customerId !== customerId) {
          throw new FieldError("NOT_FOUND", "Ordem de serviço não encontrada.");
        }
        await claimOrderForChildMutation(
          tx,
          companyId,
          orderId,
          expectedVersion,
        );
      },
    },
  };
}

export async function fieldConnectCustomer(
  command: FieldConnectionCommand,
  input: { ctoPortId: string },
): Promise<PublicNetworkConnection> {
  const { customerId, context } = await authorizeFieldConnection(command);
  return connectCustomerToPort(context, {
    customerId,
    ctoPortId: input.ctoPortId,
  });
}

export async function fieldDisconnectCustomer(
  command: FieldConnectionCommand,
  input: { expectedConnectionId: string; reason?: string | null },
): Promise<PublicNetworkConnection> {
  const { customerId, context } = await authorizeFieldConnection(command);
  return disconnectCustomer(context, {
    customerId,
    expectedConnectionId: input.expectedConnectionId,
    reason: input.reason ?? null,
  });
}

export async function fieldMoveCustomer(
  command: FieldConnectionCommand,
  input: {
    expectedConnectionId: string;
    targetCtoPortId: string;
    reason?: string | null;
  },
): Promise<MoveResult> {
  const { customerId, context } = await authorizeFieldConnection(command);
  return moveCustomerToPort(context, {
    customerId,
    expectedConnectionId: input.expectedConnectionId,
    targetCtoPortId: input.targetCtoPortId,
    reason: input.reason ?? null,
  });
}
