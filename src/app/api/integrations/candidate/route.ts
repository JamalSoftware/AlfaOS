import { AccessProfile, ERPProvider } from "@prisma/client";
import { z } from "zod";
import { jsonError, jsonOk, runApi } from "@/lib/api";
import {
  enforceCapabilityLimit,
  ERP_CAPABILITIES,
} from "@/lib/capability-rate-limit";
import { assertSameOrigin } from "@/lib/csrf";
import {
  activateErpProviderWithConfiguration,
  testCandidateConnection,
} from "@/lib/erp-provisioning";
import { getActiveIntegration } from "@/lib/erp-integration";
import { getSessionUser } from "@/lib/session";

/**
 * Configuração CANDIDATA de um provider — testar e, depois, ativar.
 *
 * Rota separada de `test-connection` de propósito. Aquela testa a configuração
 * **gravada** do ERP ativo; esta testa uma configuração que o ADMIN acabou de
 * digitar e que **não está em lugar nenhum**. São perguntas diferentes, e a
 * `ERP-1` estabeleceu que ações diferentes não compartilham efeito colateral.
 *
 * `companyId` vem **sempre** da sessão. Os schemas são `.strict()`: um
 * `companyId` no corpo é **recusado**, não descartado em silêncio.
 *
 * ## O token candidato nunca é persistido no modo `test`
 *
 * Ele existe na memória desta requisição, vai ao provider no corpo, e é
 * descartado. Só o modo `activate` o cifra e grava — e só depois de o servidor
 * reexecutar o teste.
 */

const configuration = {
  baseUrl: z.string().min(1).max(2048),
  app: z.string().min(1).max(200),
  token: z.string().min(1).max(4096),
};

const testSchema = z
  .object({
    action: z.literal("test"),
    provider: z.nativeEnum(ERPProvider),
    ...configuration,
  })
  .strict();

const activateSchema = z
  .object({
    action: z.literal("activate"),
    provider: z.nativeEnum(ERPProvider),
    ...configuration,
  })
  .strict();

const schema = z.discriminatedUnion("action", [testSchema, activateSchema]);

export async function POST(request: Request) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) return csrfBlocked;

    const session = await getSessionUser(request);
    if (!session) {
      return jsonError("Não autenticado.", 401);
    }
    /**
     * Só ADMIN. Testar uma configuração candidata faz o servidor do AlfaOS
     * bater num endereço fornecido no corpo — é superfície de saída, e não
     * pertence a despacho nem a campo. Ativar redireciona o atendimento
     * inteiro.
     */
    if (session.profile !== AccessProfile.ADMIN) {
      return jsonError("Acesso negado. Requer perfil ADMIN.", 403);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Corpo da requisição inválido.", 400);
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      // `flatten()` diz QUAL campo falhou, sem ecoar o valor — então um token
      // recusado por tamanho não volta no corpo do erro.
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    const { provider, baseUrl, app, token } = parsed.data;

    /**
     * Teto por clique, DEPOIS da autorização. Esta rota é amplificadora: cada
     * chamada vira uma requisição a um host escolhido por quem chamou, e o
     * botão é o mais fácil de repetir quando algo não funciona.
     */
    const limited = enforceCapabilityLimit(
      session.companyId,
      session.id,
      ERP_CAPABILITIES.TEST_CONNECTION,
    );
    if (limited) return limited;

    if (parsed.data.action === "test") {
      const result = await testCandidateConnection({
        provider,
        candidate: { baseUrl, app, token },
      });

      return jsonOk({
        result,
        /**
         * Explícito na resposta: testar não ativou nada. Sem este campo a tela
         * poderia sugerir que um teste bem-sucedido já configurou o provider.
         */
        activated: false,
        activeProvider: (await getActiveIntegration(session.companyId))?.provider ?? null,
      });
    }

    // `DomainError` — SSRF, reteste falhado, provider já ativo, corrida — já
    // vira resposta HTTP em `runApi`.
    const change = await activateErpProviderWithConfiguration({
      companyId: session.companyId,
      actorUserId: session.id,
      provider,
      candidate: { baseUrl, app, token },
    });

    return jsonOk({
      result: change.result,
      activated: true,
      fromProvider: change.fromProvider,
      toProvider: change.toProvider,
      integration: await getActiveIntegration(session.companyId),
    });
  });
}
