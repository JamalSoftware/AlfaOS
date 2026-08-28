import { Prisma } from "@prisma/client";
import type { InventoryMovementType, MaterialUnit } from "@prisma/client";
import { prisma } from "./prisma";
import { logAudit } from "./audit";
import {
  badRequest,
  conflict,
  isUniqueConstraintError,
  notFound,
} from "./errors";
import {
  claimOrderForChildMutation,
  loadInProgressOwnedOrder,
} from "./service-order-child-mutation";
import type { ExecutionTx } from "./service-orders";

/**
 * # Inventário como ledger
 *
 * > Não controlar estoque com `quantity = quantity - 1` (PRD §181).
 *
 * Um contador guarda o saldo e perde a história. Quando ele diverge da
 * prateleira — e diverge — não há como descobrir onde: qualquer uma das últimas
 * trezentas operações pode ter falhado no meio, e nenhuma delas deixou
 * registro. Aqui o saldo é uma SOMA sobre movimentos imutáveis, e toda
 * divergência tem um movimento que a explica.
 *
 * ## Escopo desta versão
 *
 * Catálogo + movimento + saldo derivado por técnico. Custódia de patrimônio,
 * transferência técnico→técnico, conferência periódica, extravio e manutenção
 * (PRD §210–§223) NÃO entram — e, quando entrarem, entram como valores NOVOS
 * deste mesmo enum, nunca como um segundo motor (§181, §215).
 *
 * ## O que o Field pode fazer
 *
 * Só `TECHNICIAN_TO_CUSTOMER`: consumir, no atendimento, o que já está com ele.
 * Receber do almoxarifado e devolver são operações administrativas, e o
 * aplicativo do técnico não as emite — se emitisse, o técnico poderia criar o
 * próprio saldo antes de baixá-lo, e a validação de saldo não valeria nada.
 */

// ---------------------------------------------------------------------------
// Direção
// ---------------------------------------------------------------------------

/**
 * O sinal de cada movimento sobre o saldo DO TÉCNICO.
 *
 * Fonte única da verdade: o saldo é calculado a partir deste mapa, e não de um
 * `CASE` em SQL escrito à parte. Duas listas de direções divergiriam no dia em
 * que alguém acrescentasse um tipo de movimento e lembrasse de só uma.
 *
 * A quantidade gravada é SEMPRE positiva — ver `InventoryMovementType`.
 */
export const MOVEMENT_DIRECTION: Record<InventoryMovementType, 1 | -1> = {
  WAREHOUSE_TO_TECHNICIAN: 1,
  ADJUSTMENT_IN: 1,
  TECHNICIAN_TO_CUSTOMER: -1,
  TECHNICIAN_TO_WAREHOUSE: -1,
  ADJUSTMENT_OUT: -1,
};

/** Decimal(10,3): três casas, e o que a coluna comporta. */
export const INVENTORY_QUANTITY_SCALE = 3;
export const INVENTORY_QUANTITY_MAX = 9_999_999;

/**
 * Aceita a quantidade, ou recusa.
 *
 * Cobre o que a §62 manda atacar:
 *
 * - **negativa e zero** — uma baixa de `-5` seria uma ENTRADA disfarçada, e é
 *   exatamente como se cria saldo do nada num ledger que confia no sinal do
 *   cliente;
 * - **não finita** — `NaN` e `Infinity` sobrevivem a `JSON.parse` e envenenariam
 *   toda soma futura;
 * - **casas demais** — `Decimal(10,3)` arredondaria em silêncio, e o saldo
 *   passaria a divergir do que o técnico declarou;
 * - **fracionária em item contável** — meia caixa de conector não existe, e
 *   aceitar isso deixaria o estoque com saldos impossíveis de conferir na
 *   prateleira.
 */
export function assertInventoryQuantity(
  quantity: number,
  unit: MaterialUnit,
): Prisma.Decimal {
  if (typeof quantity !== "number" || !Number.isFinite(quantity)) {
    throw badRequest("Quantidade inválida.");
  }
  if (quantity <= 0) {
    throw badRequest("A quantidade deve ser maior que zero.");
  }
  if (quantity > INVENTORY_QUANTITY_MAX) {
    throw badRequest("Quantidade acima do máximo permitido.");
  }
  const decimal = new Prisma.Decimal(quantity);
  if (decimal.decimalPlaces() > INVENTORY_QUANTITY_SCALE) {
    throw badRequest("A quantidade aceita no máximo três casas decimais.");
  }
  if (unit === "UNIT" && !decimal.isInteger()) {
    throw badRequest("Itens contados por unidade não aceitam fração.");
  }
  return decimal;
}

// ---------------------------------------------------------------------------
// Saldo
// ---------------------------------------------------------------------------

/**
 * Serializa o consumo de `(empresa, item, técnico)` dentro da transação.
 *
 * **Sem isto o saldo não protege nada.** Sob READ COMMITTED, duas baixas
 * simultâneas do último metro de cabo leem o mesmo total, as duas se acham
 * autorizadas e as duas gravam — o saldo termina negativo, e nenhuma das duas
 * transações fez nada errado isoladamente. `SUM` não trava linha nenhuma; não
 * há linha de saldo a travar, porque o saldo é derivado.
 *
 * Lock CONSULTIVO de transação: liberado automaticamente no commit ou no
 * rollback, então um processo que morra no meio não deixa o item travado.
 *
 * `hashtext` reduz os identificadores a `int4`, então duas chaves diferentes
 * podem colidir. A consequência de uma colisão é dois consumos NÃO relacionados
 * se serializarem por um instante — perda de paralelismo, nunca de correção.
 *
 * A ordem de aquisição é sempre: primeiro o lock de linha da OS
 * (`claimOrderForChildMutation`), depois este. Como todo consumo passa por
 * `consumeInventoryForOrder`, a ordem é a mesma em todos os caminhos e não há
 * ciclo de espera — que é a condição que produziria deadlock.
 */
async function lockStock(
  tx: ExecutionTx,
  companyId: string,
  itemId: string,
  technicianId: string,
): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtext(${companyId}),
      hashtext(${`${itemId}:${technicianId}`})
    )
  `;
}

/**
 * Saldo do técnico para um item, derivado dos movimentos.
 *
 * Agrupa por tipo e aplica `MOVEMENT_DIRECTION` em memória, em vez de somar com
 * um `CASE` em SQL. É mais lento por uma margem irrelevante (são poucas linhas
 * por par item/técnico) e mantém a direção definida num lugar só.
 */
export async function getTechnicianStockBalance(
  tx: ExecutionTx,
  companyId: string,
  itemId: string,
  technicianId: string,
): Promise<Prisma.Decimal> {
  const grouped = await tx.inventoryMovement.groupBy({
    by: ["type"],
    where: { companyId, itemId, technicianId },
    _sum: { quantity: true },
  });

  return grouped.reduce((total, row) => {
    const sum = row._sum.quantity ?? new Prisma.Decimal(0);
    const direction = MOVEMENT_DIRECTION[row.type];
    return direction === 1 ? total.plus(sum) : total.minus(sum);
  }, new Prisma.Decimal(0));
}

export interface TechnicianStockLine {
  itemId: string;
  code: string;
  name: string;
  unit: MaterialUnit;
  /** String, não número: `Decimal` não atravessa JSON sem perder precisão. */
  balance: string;
}

/**
 * O que o técnico tem em mãos — só o que tem saldo positivo.
 *
 * É a lista que o aplicativo mostra para escolher material. Itens zerados são
 * omitidos porque oferecê-los produziria uma recusa previsível depois de o
 * técnico já ter digitado a quantidade.
 */
export async function listTechnicianStock(
  companyId: string,
  technicianId: string,
): Promise<TechnicianStockLine[]> {
  const grouped = await prisma.inventoryMovement.groupBy({
    by: ["itemId", "type"],
    where: { companyId, technicianId },
    _sum: { quantity: true },
  });

  const balances = new Map<string, Prisma.Decimal>();
  for (const row of grouped) {
    const current = balances.get(row.itemId) ?? new Prisma.Decimal(0);
    const sum = row._sum.quantity ?? new Prisma.Decimal(0);
    balances.set(
      row.itemId,
      MOVEMENT_DIRECTION[row.type] === 1 ? current.plus(sum) : current.minus(sum),
    );
  }

  const positive = Array.from(balances.entries()).filter(([, balance]) =>
    balance.greaterThan(0),
  );
  if (positive.length === 0) return [];

  const items = await prisma.inventoryItem.findMany({
    where: {
      companyId,
      active: true,
      id: { in: positive.map(([itemId]) => itemId) },
    },
    orderBy: [{ name: "asc" }],
  });

  return items.map((item) => ({
    itemId: item.id,
    code: item.code,
    name: item.name,
    unit: item.unit,
    balance: (balances.get(item.id) ?? new Prisma.Decimal(0)).toString(),
  }));
}

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------

export const INVENTORY_CODE_MAX = 40;
export const INVENTORY_NAME_MAX = 120;

export interface InventoryItemInput {
  code: string;
  name: string;
  unit: MaterialUnit;
}

/**
 * Cadastra um item no catálogo da empresa.
 *
 * `code` é único por empresa e é o que o técnico procura. Normalizado para
 * maiúsculas: `cabo-drop` e `CABO-DROP` seriam dois itens com estoques
 * separados, e a divergência só apareceria numa conferência de prateleira.
 */
export async function createInventoryItem(
  companyId: string,
  actorUserId: string,
  input: InventoryItemInput,
): Promise<{ id: string; code: string; name: string; unit: MaterialUnit }> {
  const code = input.code.trim().toUpperCase().slice(0, INVENTORY_CODE_MAX);
  const name = input.name.trim().slice(0, INVENTORY_NAME_MAX);
  if (!code) throw badRequest("Código do item é obrigatório.");
  if (!name) throw badRequest("Nome do item é obrigatório.");

  let item;
  try {
    item = await prisma.inventoryItem.create({
      data: { companyId, code, name, unit: input.unit },
    });
  } catch (error) {
    // A unique arbitra: conferir antes deixaria duas criações simultâneas
    // passarem pela conferência.
    if (!isUniqueConstraintError(error)) throw error;
    throw conflict("Já existe um item com este código.");
  }

  await logAudit({
    companyId,
    userId: actorUserId,
    action: "INVENTORY.ITEM_CREATED",
    entity: "InventoryItem",
    entityId: item.id,
    details: `Item ${item.code} — ${item.name} (${item.unit})`,
  });

  return { id: item.id, code: item.code, name: item.name, unit: item.unit };
}

export async function listInventoryItems(companyId: string) {
  return prisma.inventoryItem.findMany({
    where: { companyId, active: true },
    orderBy: { name: "asc" },
    select: { id: true, code: true, name: true, unit: true },
  });
}

// ---------------------------------------------------------------------------
// Movimentos administrativos
// ---------------------------------------------------------------------------

export interface StockMovementInput {
  itemId: string;
  technicianId: string;
  quantity: number;
  notes?: string | null;
}

/**
 * Entrega de material do almoxarifado ao técnico.
 *
 * Operação ADMINISTRATIVA — não existe no Field. É o que dá saldo ao técnico
 * para que `consumeInventoryForOrder` tenha o que validar.
 */
export async function receiveStock(
  companyId: string,
  actorUserId: string,
  input: StockMovementInput,
): Promise<{ movementId: string; balance: string }> {
  return recordAdministrativeMovement(
    companyId,
    actorUserId,
    "WAREHOUSE_TO_TECHNICIAN",
    input,
  );
}

/** Devolução do técnico ao almoxarifado. Também administrativa. */
export async function returnStock(
  companyId: string,
  actorUserId: string,
  input: StockMovementInput,
): Promise<{ movementId: string; balance: string }> {
  return recordAdministrativeMovement(
    companyId,
    actorUserId,
    "TECHNICIAN_TO_WAREHOUSE",
    input,
  );
}

async function recordAdministrativeMovement(
  companyId: string,
  actorUserId: string,
  type: Extract<
    InventoryMovementType,
    "WAREHOUSE_TO_TECHNICIAN" | "TECHNICIAN_TO_WAREHOUSE"
  >,
  input: StockMovementInput,
): Promise<{ movementId: string; balance: string }> {
  const result = await prisma.$transaction(async (tx) => {
    const item = await tx.inventoryItem.findFirst({
      where: { id: input.itemId, companyId, active: true },
    });
    if (!item) {
      // 404 e não 403: um id de outra empresa não pode ser confirmado como
      // existente.
      throw notFound("Item de estoque não encontrado.");
    }
    const technician = await tx.technician.findFirst({
      where: { id: input.technicianId, companyId },
      select: { id: true },
    });
    if (!technician) {
      throw notFound("Técnico não encontrado.");
    }

    const quantity = assertInventoryQuantity(input.quantity, item.unit);

    await lockStock(tx, companyId, item.id, technician.id);

    if (MOVEMENT_DIRECTION[type] === -1) {
      const balance = await getTechnicianStockBalance(
        tx,
        companyId,
        item.id,
        technician.id,
      );
      if (balance.lessThan(quantity)) {
        throw conflict(
          `Saldo insuficiente: o técnico tem ${balance.toString()} ${item.unit}.`,
        );
      }
    }

    const movement = await tx.inventoryMovement.create({
      data: {
        companyId,
        itemId: item.id,
        type,
        quantity,
        technicianId: technician.id,
        createdByUserId: actorUserId,
        notes: input.notes?.trim().slice(0, 300) || null,
      },
    });

    const balance = await getTechnicianStockBalance(
      tx,
      companyId,
      item.id,
      technician.id,
    );
    return { movementId: movement.id, balance: balance.toString(), item };
  });

  await logAudit({
    companyId,
    userId: actorUserId,
    action: `INVENTORY.${type}`,
    entity: "InventoryMovement",
    entityId: result.movementId,
    details: `${input.quantity} ${result.item.unit} de ${result.item.code} (saldo do técnico: ${result.balance})`,
  });

  return { movementId: result.movementId, balance: result.balance };
}

// ---------------------------------------------------------------------------
// Consumo no atendimento — o comando do Field
// ---------------------------------------------------------------------------

export interface ConsumeInventoryInput {
  itemId: string;
  quantity: number;
  expectedOrderVersion: number;
  notes?: string | null;
}

export interface ConsumeInventoryResult {
  movementId: string;
  materialUsageId: string;
  itemCode: string;
  itemName: string;
  unit: MaterialUnit;
  quantity: string;
  /** Saldo do técnico DEPOIS da baixa. */
  remainingBalance: string;
}

/**
 * Baixa material do estoque do técnico contra uma OS em andamento.
 *
 * ## A ordem das travas importa
 *
 * 1. posse e estado da OS (`loadInProgressOwnedOrder`);
 * 2. `claimOrderForChildMutation` — compare-and-set na OS, que serializa contra
 *    a conclusão e contra as outras mutações-filhas;
 * 3. `lockStock` — lock consultivo que serializa contra outra baixa do MESMO
 *    item pelo MESMO técnico, possivelmente em OUTRA OS;
 * 4. leitura do saldo, já protegida;
 * 5. movimento + linha de uso.
 *
 * O passo 3 é o que a §62 manda atacar com "race de duas baixas". Os passos 2 e
 * 3 protegem coisas diferentes e nenhum substitui o outro: o CAS da OS não vê
 * uma baixa feita a partir de outra OS, e o lock de estoque não sabe que a OS
 * fechou.
 *
 * ## Saldo é do TÉCNICO, não da empresa
 *
 * A validação é contra o que ESTE técnico recebeu. Um técnico não consome o
 * material que está na van de outro — e é isso que a §62 chama de "estoque de
 * outro Technician". O `technicianId` sai da posse da OS, nunca do corpo.
 */
export async function consumeInventoryForOrder(
  companyId: string,
  actorUserId: string,
  orderId: string,
  input: ConsumeInventoryInput,
): Promise<ConsumeInventoryResult> {
  const result = await prisma.$transaction(async (tx) => {
    const { technician, order } = await loadInProgressOwnedOrder(
      tx,
      companyId,
      actorUserId,
      orderId,
    );

    const item = await tx.inventoryItem.findFirst({
      where: { id: input.itemId, companyId, active: true },
    });
    if (!item) {
      throw notFound("Item de estoque não encontrado.");
    }

    const quantity = assertInventoryQuantity(input.quantity, item.unit);

    await claimOrderForChildMutation(
      tx,
      companyId,
      orderId,
      input.expectedOrderVersion,
    );

    await lockStock(tx, companyId, item.id, technician.id);

    const balance = await getTechnicianStockBalance(
      tx,
      companyId,
      item.id,
      technician.id,
    );
    if (balance.lessThan(quantity)) {
      // Conflito, não erro de validação: o pedido é legítimo e a mesma
      // requisição pode passar depois que o técnico receber material.
      throw conflict(
        `Saldo insuficiente de ${item.name}. Disponível: ${balance.toString()} ${item.unit}.`,
      );
    }

    const movement = await tx.inventoryMovement.create({
      data: {
        companyId,
        itemId: item.id,
        type: "TECHNICIAN_TO_CUSTOMER",
        quantity,
        technicianId: technician.id,
        serviceOrderId: order.id,
        createdByUserId: actorUserId,
        notes: input.notes?.trim().slice(0, 300) || null,
      },
    });

    // A linha de uso é a PROJEÇÃO que o fechamento lê. O movimento é a
    // autoridade do saldo; as duas nascem na mesma transação para que não
    // exista consumo sem registro nem registro sem consumo.
    const usage = await tx.serviceOrderMaterialUsage.create({
      data: {
        companyId,
        serviceOrderId: order.id,
        createdByUserId: actorUserId,
        description: `${item.code} — ${item.name}`.slice(0, 200),
        quantity,
        unit: item.unit,
        inventoryItemId: item.id,
        inventoryMovementId: movement.id,
      },
    });

    const remaining = balance.minus(quantity);

    await tx.serviceOrderEvent.create({
      data: {
        companyId,
        serviceOrderId: order.id,
        userId: actorUserId,
        event: "MATERIAL_USED",
        metadata: {
          technicianId: technician.id,
          itemCode: item.code,
          quantity: quantity.toString(),
          unit: item.unit,
        },
      },
    });

    return {
      movementId: movement.id,
      materialUsageId: usage.id,
      itemCode: item.code,
      itemName: item.name,
      unit: item.unit,
      quantity: quantity.toString(),
      remainingBalance: remaining.toString(),
    };
  });

  await logAudit({
    companyId,
    userId: actorUserId,
    action: "INVENTORY.TECHNICIAN_TO_CUSTOMER",
    entity: "InventoryMovement",
    entityId: result.movementId,
    details: `${result.quantity} ${result.unit} de ${result.itemCode} consumidos na OS (saldo restante: ${result.remainingBalance})`,
  });

  return result;
}
