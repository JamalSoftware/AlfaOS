import { AccessProfile } from "@prisma/client";
import { z } from "zod";
import {
  consumeCapabilityToken,
  ERP_CAPABILITIES,
} from "@/lib/capability-rate-limit";
import { revealConnectionPasswordForOrder } from "@/lib/customer-connections";
import { assertCanExecute } from "@/lib/field/auth";
import { FieldError } from "@/lib/field/errors";
import { fieldOk, noStore, runFieldApi } from "@/lib/field/response";
import { readFieldBody, requireFieldPrincipal } from "@/lib/field/route";

/**
 * `POST /api/field/v1/service-orders/:id/pppoe/reveal`
 *
 * Revelação explícita da senha de conexão do cliente da OS.
 *
 * ## Por que POST, e por que uma rota só para isto
 *
 * Um GET carregaria os parâmetros na URL — que entra em log de servidor,
 * histórico e `Referer` — e seria pré-buscável e cacheável. Revelar um segredo
 * não é leitura inofensiva: é um evento auditado, disparado por um gesto
 * deliberado do técnico diante do cliente.
 *
 * O detalhe da OS (`GET .../:id`) devolve apenas `passwordConfigured`. O texto
 * claro **nunca** viaja junto do payload operacional, senão estaria no cache do
 * aplicativo em todo aparelho que abriu a OS.
 *
 * ## A autorização é do domínio, não desta rota
 *
 * `revealConnectionPasswordForOrder` é o MESMO serviço que a web usa: ele
 * checa posse antes de elegibilidade (para não virar oráculo de existência de
 * OS), valida a conexão contra o cliente da OS, recusa DISPATCHER e faz a
 * auditoria OBRIGATÓRIA — aquela cuja falha aborta a entrega, porque nada além
 * daquela linha registra que o segredo saiu do servidor.
 *
 * ## O que o aplicativo faz com o valor
 *
 * Mostra e esquece. **Senha PPPoE em texto claro não é persistida offline**
 * (`docs/SECURITY.md` §8.9): cache offline é armazenamento durável num aparelho
 * que anda pela rua e é roubado. Isso é contrato do cliente Flutter; o que o
 * servidor pode garantir — e garante — é `no-store` e teto de frequência.
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
  return runFieldApi(async () => {
    const principal = await requireFieldPrincipal(request);
    assertCanExecute(principal);

    const body = await readFieldBody(request, revealSchema);

    /*
      Teto DEPOIS da autenticação e da elegibilidade.

      Consumido antes, uma chamada sem token — ou de outro tenant — gastaria a
      cota de quem tem direito a ela, e a sondagem viraria negação de serviço
      contra o técnico legítimo.
    */
    const quota = consumeCapabilityToken(
      principal.user.companyId,
      principal.user.id,
      ERP_CAPABILITIES.FIELD_PPPOE_REVEAL,
    );
    if (!quota.allowed) {
      throw new FieldError(
        "RATE_LIMITED",
        "Muitas revelações em sequência. Tente novamente em instantes.",
      );
    }

    const password = await revealConnectionPasswordForOrder(
      principal.user.companyId,
      { userId: principal.user.id, profile: AccessProfile.TECHNICIAN },
      context.params.id,
      body.connectionId,
    );

    /*
      SOMENTE a senha.

      Nada de usuário, cliente, conexão ou OS: quem chamou já sabe tudo isso, e
      repetir só aumentaria o que vaza se esta resposta parar onde não deve.
    */
    return noStore(fieldOk({ password }));
  });
}
