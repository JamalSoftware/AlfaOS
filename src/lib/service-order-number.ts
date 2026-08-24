import { Prisma } from "@prisma/client";

/**
 * Alocação do número operacional da OS (PRD §17).
 *
 * `ServiceOrder.id` é a identidade TÉCNICA — chave primária, chave estrangeira
 * e o valor que aparece na URL. `ServiceOrder.number` é a identidade
 * OPERACIONAL HUMANA: sequencial por empresa, dito ao telefone e anotado numa
 * ficha de campo. Uma nunca substitui a outra.
 */

/**
 * Cliente Prisma aceito pelo alocador.
 *
 * Deliberadamente estrutural, e não `PrismaClient`: o alocador PRECISA rodar
 * dentro da transação que cria a OS, e o cliente transacional do Prisma não é
 * um `PrismaClient`. O mesmo tipo também deixa fixtures de teste/E2E, que
 * carregam a própria instância apontada para o banco de teste, usarem esta
 * função em vez de reimplementarem a numeração — uma fixture com regra
 * própria testaria uma sequência que a aplicação não usa.
 */
export interface ServiceOrderNumberAllocator {
  $queryRaw<T = unknown>(
    query: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ): Promise<T>;
}

/**
 * Reserva o próximo número da empresa e o devolve.
 *
 * ## Por que um contador, e não `MAX(number) + 1`
 *
 * Sob READ COMMITTED — o nível padrão do PostgreSQL e do Prisma — duas
 * transações concorrentes leem o MESMO máximo antes de qualquer uma gravar, e
 * as duas calculam o mesmo próximo número. Uma delas viola a unique
 * `(companyId, number)` e a criação da OS falha; pior, sem a unique as duas
 * gravariam o mesmo número. Nenhum `SELECT` de leitura serializa escritas.
 *
 * ## Por que ESTA instrução
 *
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING` é UMA instrução atômica:
 *
 * - primeira OS da empresa: o `INSERT` cria a linha do contador com 1. Não
 *   existe passo de seed a esquecer quando uma empresa é cadastrada, nem
 *   backfill para empresa nova;
 * - as demais: o `DO UPDATE` toma o lock da linha do contador, incrementa e
 *   devolve o valor já gravado. Uma segunda transação na mesma empresa fica
 *   bloqueada nesse lock, e ao ser liberada reavalia sobre o valor COMMITADO —
 *   ela não pode reler o máximo antigo. É isso que torna impossível duas
 *   criações simultâneas receberem o mesmo número.
 *
 * O lock é por EMPRESA (a linha do contador daquela empresa), então a criação
 * de OS de uma empresa nunca serializa a de outra.
 *
 * ## Por que não uma SEQUENCE do PostgreSQL
 *
 * Sequence é por objeto, não por tenant: seria uma sequence por empresa,
 * criada por DDL em tempo de execução, com um objeto de banco vazando a cada
 * empresa cadastrada. E sequence é não-transacional — um rollback queimaria o
 * número. Aqui o incremento é transacional: se a criação da OS falhar, o
 * número volta a estar disponível porque nunca chegou a ficar gravado em OS
 * nenhuma. O que a sequência nunca faz é REUTILIZAR um número já atribuído.
 *
 * ## Contrato de uso
 *
 * Chamar SEMPRE dentro da mesma transação do `create` da OS. Fora dela, o lock
 * é liberado no fim da instrução e o número reservado pode acabar não sendo
 * usado (ou, num caminho de erro, ser perdido).
 *
 * `companyId` vem sempre da sessão do servidor. O cliente HTTP nunca envia
 * `number` nem `companyId` — os schemas Zod de criação são `.strict()` e não
 * declaram nenhum dos dois, então enviá-los é 400.
 */
export async function allocateServiceOrderNumber(
  client: ServiceOrderNumberAllocator,
  companyId: string,
): Promise<number> {
  const rows = await client.$queryRaw<{ lastNumber: number }[]>(Prisma.sql`
    INSERT INTO "service_order_counters" ("companyId", "lastNumber", "updatedAt")
    VALUES (${companyId}, 1, CURRENT_TIMESTAMP)
    ON CONFLICT ("companyId") DO UPDATE
      SET "lastNumber" = "service_order_counters"."lastNumber" + 1,
          "updatedAt" = CURRENT_TIMESTAMP
    RETURNING "lastNumber"
  `);

  const next = rows[0]?.lastNumber;
  /**
   * Falha FECHADA. A instrução acima sempre devolve uma linha; se não
   * devolveu, algo saiu do contrato e criar a OS com um número inventado
   * (0, `undefined`, um segundo `MAX+1`) produziria exatamente a colisão que
   * este módulo existe para impedir.
   */
  if (typeof next !== "number" || !Number.isInteger(next) || next <= 0) {
    throw new Error(
      "Não foi possível alocar o número da OS para esta empresa.",
    );
  }
  return next;
}
