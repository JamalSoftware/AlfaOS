import { z } from "zod";
import { jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { connectCustomerToPort } from "@/lib/cto-connections";
import { requireCtoAccess } from "@/lib/cto-access";
import { getCustomerNetworkView } from "@/lib/cto-read-model";
import {
  idempotencyActor,
  parseIdempotencyKey,
  withIdempotency,
} from "@/lib/field/idempotency";

/**
 * `POST /api/cto-connections` — liga um cliente a uma porta.
 * `GET  /api/cto-connections?customerId=` — onde ele está e onde esteve.
 *
 * ## A rota é um ADAPTADOR
 *
 * Ela autentica, valida forma, monta a procedência e chama o domínio. Nenhuma
 * regra de negócio vive aqui: CTO ativa, faixa, ofertabilidade, unicidade do
 * vínculo, transação e auditoria são de `cto-connections.ts`, e reimplementá-las
 * na borda criaria uma segunda autoridade que diverge na primeira correção.
 *
 * ## `source` é do servidor
 *
 * `WEB` é montado aqui e o cliente não tem como influenciá-lo — assim como
 * `companyId`, `technicianId`, `serviceOrderId` e os carimbos de tempo. O
 * schema é `.strict()`, então mandar qualquer um deles é `400`, e não um campo
 * silenciosamente descartado: um payload recusado ensina, um ignorado esconde.
 *
 * ## Namespace próprio, e não `customers/:id/connections`
 *
 * Aquele caminho já existe e é a credencial **PPPoE** (`CustomerConnection`).
 * São coisas diferentes, e pendurar a topologia ao lado do segredo de acesso
 * faria as duas parecerem a mesma capability.
 */
const connectSchema = z
  .object({
    customerId: z.string().min(1),
    ctoPortId: z.string().min(1),
  })
  .strict();

export async function POST(request: Request) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) return csrfBlocked;

    const access = await requireCtoAccess(request);
    if (!access.ok) return access.response;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Corpo da requisição inválido.", 400);
    }
    const parsed = connectSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    const key = parseIdempotencyKey(request);
    const outcome = await withIdempotency(
      idempotencyActor(access.session.companyId, access.session.id),
      "cto.connect",
      key,
      parsed.data,
      async () => {
        const connection = await connectCustomerToPort(
          {
            companyId: access.session.companyId,
            provenance: { source: "WEB", actorUserId: access.session.id },
          },
          parsed.data,
        );
        return { status: 201, body: { connection } };
      },
    );

    return jsonOk(outcome.body, outcome.status);
  });
}

export async function GET(request: Request) {
  return runApi(async () => {
    const access = await requireCtoAccess(request);
    if (!access.ok) return access.response;

    const customerId = new URL(request.url).searchParams.get("customerId");
    if (!customerId) {
      return jsonError("Informe o cliente.", 400);
    }

    /*
      Sem verificação de existência do cliente antes da consulta.

      O predicado já leva `companyId`, então um cliente de outra empresa devolve
      vazio — e vazio é a resposta certa. Um `404` distinguiria "não existe" de
      "existe e não é seu", que é a enumeração que o módulo inteiro evita.
    */
    const view = await getCustomerNetworkView(
      access.session.companyId,
      customerId,
    );
    return jsonOk({ network: view });
  });
}
