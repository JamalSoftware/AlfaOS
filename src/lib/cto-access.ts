import { AccessProfile } from "@prisma/client";
import type { NextResponse } from "next/server";
import { jsonError } from "./api";
import { isCtoNetworkEnabled } from "./cto";
import { getSessionUser } from "./session";
import type { SessionUser } from "./session";

/**
 * # O portão do módulo CTO
 *
 * Um lugar só, e todas as rotas passam por ele. Espalhar a sequência por cinco
 * arquivos garantiria que a sexta rota esquecesse uma das etapas.
 *
 * ## A ordem é a parte que importa
 *
 * ```text
 * 1. sessão ausente          401
 * 2. capability desligada    404
 * 3. perfil errado           403
 * ```
 *
 * **A capability vem ANTES do perfil, e trocar a ordem vaza informação.** Se o
 * perfil fosse verificado primeiro, um DISPATCHER de uma empresa que não
 * contratou o módulo receberia 403 — e 403 significa "isto existe, você é que
 * não pode". A empresa descobriria pela resposta de erro que há um módulo CTO
 * que ela não tem. Com a capability primeiro, quem não contratou vê a mesma
 * coisa que veria se a rota não existisse.
 *
 * ## Capability não é permissão
 *
 * As duas verificações são independentes e as duas são obrigatórias. Ligada, a
 * capability diz que o módulo existe para a empresa; ela **não** diz que quem
 * chamou pode agir. E o inverso também vale: perfil correto numa empresa sem a
 * capability continua sendo 404.
 *
 * A capability é lida do BANCO a cada requisição, e não da sessão: o token é
 * emitido no login e carregaria o valor de então, de modo que desligar o módulo
 * só teria efeito quando cada pessoa reautenticasse.
 */

/** Quem gerencia CTO na `CTO-1`. Leitura abre por fase que precise, não antes. */
const MANAGE_PROFILES: AccessProfile[] = [AccessProfile.ADMIN];

export type CtoAccess =
  | { ok: true; session: SessionUser }
  | { ok: false; response: NextResponse };

export async function requireCtoAccess(
  request: Request,
  profiles: AccessProfile[] = MANAGE_PROFILES,
): Promise<CtoAccess> {
  const session = await getSessionUser(request);
  if (!session) {
    return { ok: false, response: jsonError("Não autenticado.", 401) };
  }

  // `session.companyId` é a ÚNICA fonte de tenant daqui para baixo. Nenhuma
  // rota do módulo lê empresa de corpo, query ou header.
  if (!(await isCtoNetworkEnabled(session.companyId))) {
    return { ok: false, response: jsonError("Recurso não encontrado.", 404) };
  }

  if (!profiles.includes(session.profile)) {
    return {
      ok: false,
      response: jsonError("Você não tem permissão para esta ação.", 403),
    };
  }

  return { ok: true, session };
}
