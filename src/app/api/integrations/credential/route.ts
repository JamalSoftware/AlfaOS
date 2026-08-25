import { AccessProfile, type ERPCredentialKind } from "@prisma/client";
import { z } from "zod";
import { jsonError, jsonOk, runApi } from "@/lib/api";
import { assertSameOrigin } from "@/lib/csrf";
import { getSessionUser } from "@/lib/session";
import { CredentialEncryptionUnavailableError } from "@/lib/erp-credentials";
import {
  CREDENTIAL_MAX_LENGTH,
  CREDENTIAL_MIN_LENGTH,
  listCredentialStatus,
  removeCredentialFor,
  saveCredentialFor,
} from "@/lib/erp-credential-store";
import { prisma } from "@/lib/prisma";

/**
 * Gestão das credenciais de ERP. ADMIN only, sempre da PRÓPRIA empresa.
 *
 * `companyId` nunca é lido do request — vem da sessão, então não existe forma
 * de payload que alcance a credencial de outro tenant.
 *
 * Cada API do provider tem a sua credencial, endereçada por `kind`. Uma
 * requisição toca exatamente UMA: gravar o Chatbot é um upsert numa linha,
 * removê-lo é um delete numa linha. Não existe caminho que alcance as duas, e é
 * isso que impede a regressão em que mexer numa credencial destruía a outra.
 */

/** APIs do ReceitaNet que têm credencial própria. */
const KINDS = ["CALLCENTER", "CHATBOT"] as const satisfies readonly ERPCredentialKind[];

/**
 * `.strict()` com exatamente os campos previstos.
 *
 * Recusar em vez de descartar importa mais aqui que em qualquer outro lugar:
 * quem envia `ciphertext`, `iv`, `authTag`, `last4`, `aadVersion` ou
 * `companyId` está confuso ou sondando, e um 200 que ignorasse esses campos em
 * silêncio sugeriria que foram aceitos.
 *
 * `aadVersion` em particular NUNCA vem do cliente: ela sai da linha. Aceitá-la
 * permitiria pedir o formato de AAD mais fraco para uma credencial nova.
 */
const saveSchema = z
  .object({
    kind: z.enum(KINDS),
    token: z.string().min(CREDENTIAL_MIN_LENGTH).max(CREDENTIAL_MAX_LENGTH),
  })
  .strict();

const removeSchema = z.object({ kind: z.enum(KINDS) }).strict();

async function requireAdmin(request: Request) {
  const session = await getSessionUser(request);
  if (!session) {
    return { error: jsonError("Não autenticado.", 401) };
  }
  if (session.profile !== AccessProfile.ADMIN) {
    return { error: jsonError("Acesso negado. Requer perfil ADMIN.", 403) };
  }
  return { session };
}

/** Provider configurado da empresa. Sem integração, não há credencial a gerir. */
async function providerOf(companyId: string) {
  const integration = await prisma.eRPIntegration.findUnique({
    where: { companyId },
    select: { provider: true },
  });
  return integration?.provider ?? null;
}

async function parseBody(request: Request): Promise<unknown | undefined> {
  try {
    const text = await request.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return undefined;
  }
}

/**
 * Status somente-leitura das DUAS credenciais.
 *
 * Devolve configurado / last4 / atualizado-em, e nada além. Não existe caminho
 * de código, para nenhum papel, que devolva o token.
 */
export async function GET(request: Request) {
  return runApi(async () => {
    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;

    const provider = await providerOf(auth.session.companyId);
    if (!provider) {
      return jsonOk({ provider: null, credentials: [] });
    }

    const credentials = await listCredentialStatus(
      auth.session.companyId,
      provider,
      [...KINDS],
    );
    return jsonOk({ provider, credentials });
  });
}

/** Grava ou substitui a credencial de UMA API. */
export async function PUT(request: Request) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) return csrfBlocked;

    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;

    const body = await parseBody(request);
    if (body === undefined) {
      return jsonError("Corpo da requisição inválido.", 400);
    }

    const parsed = saveSchema.safeParse(body);
    if (!parsed.success) {
      // `flatten()` diz QUAL campo falhou e por quê — nunca ecoa o valor
      // enviado, então um token recusado não volta no corpo do erro.
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    const provider = await providerOf(auth.session.companyId);
    if (!provider) {
      return jsonError("Integração não configurada para esta empresa.", 404);
    }

    try {
      const status = await saveCredentialFor(
        auth.session.companyId,
        auth.session.id,
        provider,
        parsed.data.kind,
        parsed.data.token,
      );
      return jsonOk({ credential: status });
    } catch (error) {
      if (error instanceof CredentialEncryptionUnavailableError) {
        /**
         * Falha fechada, e dita com todas as letras. A alternativa — guardar o
         * token sem cifra "por enquanto" — é exatamente o desfecho que este
         * desenho inteiro existe para impedir. A mensagem nomeia a configuração
         * ausente, nunca a chave.
         */
        return jsonError(
          "Criptografia de credenciais indisponível. A credencial NÃO foi salva. " +
            "Configure ERP_CREDENTIAL_ENCRYPTION_KEY no servidor.",
          503,
        );
      }
      throw error;
    }
  });
}

/**
 * Remove a credencial de UMA API. Ação explícita — campo vazio no formulário
 * não chega aqui.
 */
export async function DELETE(request: Request) {
  return runApi(async () => {
    const csrfBlocked = assertSameOrigin(request);
    if (csrfBlocked) return csrfBlocked;

    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;

    const body = await parseBody(request);
    if (body === undefined) {
      return jsonError("Corpo da requisição inválido.", 400);
    }

    const parsed = removeSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Dados inválidos.", 400, parsed.error.flatten());
    }

    const provider = await providerOf(auth.session.companyId);
    if (!provider) {
      return jsonError("Integração não configurada para esta empresa.", 404);
    }

    // Deliberadamente NÃO exige criptografia disponível: apagar um segredo não
    // pode depender de conseguir lê-lo.
    await removeCredentialFor(
      auth.session.companyId,
      auth.session.id,
      provider,
      parsed.data.kind,
    );

    const credentials = await listCredentialStatus(
      auth.session.companyId,
      provider,
      [...KINDS],
    );
    return jsonOk({ credentials });
  });
}
