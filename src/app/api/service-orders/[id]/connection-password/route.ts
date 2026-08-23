import { z } from "zod";
import { NextResponse } from "next/server";
import { jsonError, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import { revealConnectionPasswordForOrder } from "@/lib/customer-connections";

/**
 * Revelação sob demanda da senha de conexão do cliente da OS.
 *
 * POST, e não GET, por três razões concretas: um GET carrega os parâmetros na
 * URL (que entra em log de servidor, histórico e Referer), é pré-buscável e
 * cacheável por intermediários, e não passa pela proteção Same-Origin que o
 * projeto aplica a rotas mutantes. Revelar um segredo não é uma leitura
 * inofensiva — é um evento auditado.
 *
 * A resposta carrega SOMENTE a senha. Nada de username, cliente, conexão ou
 * OS: o chamador já sabe tudo isso, e repetir aumentaria a superfície do que
 * vaza se a resposta for parar onde não deve.
 */
const revealSchema = z
  .object({
    connectionId: z.string().min(1, "Conexão é obrigatória."),
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

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Corpo da requisição inválido.", 400);
    }

    /**
     * Schema strict com UM campo. `companyId`, `customerId` e `technicianId`
     * não existem aqui: a empresa vem da sessão, o cliente vem da OS e o
     * técnico vem do `userId` da sessão. Enviá-los resulta em 400.
     *
     * O `connectionId` é o único valor aceito do cliente, e o domínio o valida
     * contra o cliente da OS — uma conexão de outro cliente vira 404.
     */
    const parsed = revealSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400);
    }

    const password = await revealConnectionPasswordForOrder(
      session.companyId,
      { userId: session.id, profile: session.profile },
      context.params.id,
      parsed.data.connectionId,
    );

    const response = NextResponse.json({ ok: true, data: { password } });
    // Sem cache em lugar nenhum: nem no browser, nem em proxy, nem no
    // back/forward cache. Um segredo revelado uma vez não pode ser reexibido
    // por navegação.
    response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
    response.headers.set("Pragma", "no-cache");
    return response;
  });
}
