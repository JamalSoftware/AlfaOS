import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import { assertProfile, jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import { expectedVersionSchema } from "@/lib/version";
import { assignTechnician } from "@/lib/service-orders";

const STAFF_PROFILES = [AccessProfile.ADMIN, AccessProfile.DISPATCHER];

const assignSchema = z
  .object({
    technicianId: z.string().min(1, "Técnico é obrigatório."),
    /**
     * `version` da OS que o cliente leu (vem no `GET /api/service-orders/[id]`).
     * Quando enviada, vira o predicado do compare-and-set: atribuir sobre uma
     * leitura obsoleta é recusado com 409 em vez de sobrescrever quem chegou
     * antes. Opcional de propósito — sem ela o comportamento antigo (relê a
     * versão corrente e aceita) é preservado, então nenhum chamador existente
     * quebra.
     */
    expectedVersion: expectedVersionSchema.optional(),
    /**
     * Onde a OS entra na fila do técnico (PRD Parte XII).
     *
     * **Opcional, e a ausência é a regra normal**: sem ela a OS entra no fim da
     * própria banda de prioridade — chegar depois não é ser mais importante, e
     * uma `URGENT` nova não ultrapassa as urgentes que o despachante já
     * ordenou (PRD §317).
     *
     * Existe para o caso em que quem atribui já sabe a posição — atribuir e
     * posicionar numa requisição só, em vez de duas com uma janela no meio.
     */
    targetPosition: z.number().int().min(1).max(10_000).optional(),
  })
  .strict();

export async function POST(
  request: Request,
  context: { params: { id: string } },
) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) {
      return csrfBlocked;
    }

    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    const denied = assertProfile(session.profile, STAFF_PROFILES);
    if (denied) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Corpo da requisição inválido.", 400);
    }

    const parsed = assignSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    const order = await assignTechnician(
      session.companyId,
      session.id,
      context.params.id,
      parsed.data.technicianId,
      parsed.data.expectedVersion,
      parsed.data.targetPosition,
    );
    /*
      A resposta NÃO muda de forma.

      O efeito de fila já acontece dentro de `assignTechnician`, na transação
      que sempre existiu (DQ-2). Acrescentar a fila aqui obrigaria quem já
      consome esta rota — o painel Web e os testes — a lidar com um campo novo
      para nada: quem precisa da fila lê `GET .../queue`, que é a rota dela.
    */
    return jsonOk({ serviceOrder: order });
  });
}
