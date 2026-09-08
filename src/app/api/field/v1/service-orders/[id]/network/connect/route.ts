import { z } from "zod";
import { fieldOrderCommand } from "@/lib/field/command";
import {
  assertFieldCtoEnabled,
  fieldConnectCustomer,
  toFieldConnectionResult,
} from "@/lib/field/cto";
import {
  clientMutationId,
  fieldExpectedVersion,
  fieldResourceId,
} from "@/lib/field/route";

/**
 * `POST /api/field/v1/service-orders/:id/network/connect`
 *
 * Liga o cliente **da OS** a uma porta.
 *
 * ## O payload não tem cliente, e isso é a proteção
 *
 * `customerId` não é campo desta rota. O cliente é derivado da OS do caminho,
 * de modo que a classe inteira de *OS legítima do meu técnico usada para
 * conectar outra pessoa* deixa de existir — não por uma comparação que alguém
 * precisa lembrar de escrever, mas porque não há onde escrever o valor. Um
 * corpo que traga `customerId` recebe `400` pelo `.strict()`, junto com
 * `companyId`, `source`, `technicianId`, `serviceOrderId` e qualquer carimbo de
 * tempo.
 *
 * ## Online, e só
 *
 * Não existe fila offline para esta operação. Duas pessoas reservariam a mesma
 * porta sem rede, e a reconciliação teria de escolher um perdedor **depois** de
 * os dois terem subido no poste. Sem servidor, a operação não acontece
 * (`docs/CTO-NETWORK-DISTRIBUTION.md` §24.21).
 *
 * ## `expectedVersion`
 *
 * É o mesmo compare-and-set de evidência, material, equipamento, assinatura e
 * checklist. Ele **não** protege a ocupação da porta — isso é do lock da CTO e
 * das uniques parciais —, e sim a sessão operacional da OS: sem ele, a OS
 * poderia ser concluída entre a autorização e a escrita, e a timeline ganharia
 * um evento depois do fechamento.
 */
const schema = z
  .object({
    expectedVersion: fieldExpectedVersion,
    ctoPortId: fieldResourceId,
    clientMutationId,
  })
  .strict();

export const POST = fieldOrderCommand(
  "service-order.network.connect",
  schema,
  async ({ principal, body, orderId }) => {
    const connection = await fieldConnectCustomer(
      { principal, orderId, expectedVersion: body.expectedVersion },
      { ctoPortId: body.ctoPortId },
    );

    return {
      status: 201,
      resourceId: connection.id,
      body: {
        connection: toFieldConnectionResult(connection),
        previous: null,
      },
    };
  },
  { precondition: assertFieldCtoEnabled },
);
