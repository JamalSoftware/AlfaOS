import type { ERPCredentialKind, ERPProvider } from "@prisma/client";
import { logAudit } from "./audit";
import {
  decryptCredential,
  encryptCredential,
  type CredentialContext,
} from "./erp-credential-cipher";
import { badRequest, notFound } from "./errors";
import { prisma } from "./prisma";

/**
 * Credenciais de ERP, uma por (empresa, provider, API).
 *
 * O ReceitaNet publica APIs distintas com integrações distintas do lado dele: o
 * token do CallCenter não abre o Chatbot. Mesmo que uma empresa configure o
 * mesmo valor nas duas, elas continuam sendo credenciais separadas — e o motivo
 * é ciclo de vida, não organização.
 *
 * **Isolamento é estrutural, não uma regra que alguém precisa lembrar.** Cada
 * credencial é uma LINHA. Gravar a do Chatbot é um `upsert` numa linha;
 * removê-la é um `delete` numa linha. Não existe caminho de código capaz de
 * tocar a outra, porque não existe escrita que alcance as duas. Foi justamente
 * o acoplamento oposto — credencial como colunas de uma linha compartilhada —
 * que já causou perda de token numa troca de provider.
 *
 * O token NUNCA sai daqui a não ser por `getCredentialFor`, que é chamada
 * server-side por quem vai montar a requisição ao provider. Nada neste módulo
 * devolve token para resposta HTTP, log, auditoria ou mensagem de erro.
 */

export const CREDENTIAL_MIN_LENGTH = 8;
export const CREDENTIAL_MAX_LENGTH = 4096;

export interface ErpCredentialSlotStatus {
  kind: ERPCredentialKind;
  configured: boolean;
  /** Últimos 4 caracteres. Serve para reconhecer QUAL token está lá. */
  last4: string | null;
  updatedAt: Date | null;
}

/**
 * Contexto do AAD a partir da linha REAL.
 *
 * `v1` é o formato das credenciais migradas de `ERPIntegration`, cifradas
 * quando só existia uma por empresa: elas não têm `kind` no AAD, e recomputá-lo
 * com `kind` mudaria os bytes, fazendo a verificação GCM rejeitar um token que
 * a empresa já tem configurado e funcionando.
 *
 * Toda gravação nova é `v2`. A versão nunca é escolhida pelo chamador — ela sai
 * da linha.
 */
function aadContextFor(row: {
  companyId: string;
  provider: ERPProvider;
  kind: ERPCredentialKind;
  aadVersion: string;
}): CredentialContext {
  if (row.aadVersion === "v1") {
    return { companyId: row.companyId, provider: row.provider };
  }
  return { companyId: row.companyId, provider: row.provider, kind: row.kind };
}

/** Status das credenciais da empresa para um provider. Nunca o token. */
export async function listCredentialStatus(
  companyId: string,
  provider: ERPProvider,
  kinds: ERPCredentialKind[],
): Promise<ErpCredentialSlotStatus[]> {
  const rows = await prisma.eRPCredential.findMany({
    // Tenant em SQL.
    where: { companyId, provider },
    select: { kind: true, credentialLast4: true, credentialUpdatedAt: true },
  });

  return kinds.map((kind) => {
    const row = rows.find((r) => r.kind === kind);
    return {
      kind,
      configured: row !== undefined,
      last4: row?.credentialLast4 ?? null,
      updatedAt: row?.credentialUpdatedAt ?? null,
    };
  });
}

/**
 * Grava (ou substitui) UMA credencial.
 *
 * Não toca em nenhuma outra linha — nem da mesma empresa, nem do mesmo
 * provider. Trocar o token do Chatbot deixa o do CallCenter exatamente onde
 * estava.
 */
export async function saveCredentialFor(
  companyId: string,
  actorUserId: string,
  provider: ERPProvider,
  kind: ERPCredentialKind,
  token: string,
): Promise<ErpCredentialSlotStatus> {
  if (token.length < CREDENTIAL_MIN_LENGTH) {
    throw badRequest(`Token deve ter ao menos ${CREDENTIAL_MIN_LENGTH} caracteres.`);
  }
  if (token.length > CREDENTIAL_MAX_LENGTH) {
    throw badRequest(`Token deve ter no máximo ${CREDENTIAL_MAX_LENGTH} caracteres.`);
  }

  /**
   * Cifra ANTES de qualquer escrita: chave ausente lança aqui, e nada é
   * gravado. O contexto vem da empresa da sessão e do par (provider, kind) da
   * própria chamada — nada que o cliente HTTP envie influencia o AAD.
   */
  const encrypted = encryptCredential(token, { companyId, provider, kind });
  const last4 = token.slice(-4);

  const saved = await prisma.eRPCredential.upsert({
    where: { companyId_provider_kind: { companyId, provider, kind } },
    create: {
      companyId,
      provider,
      kind,
      credentialCiphertext: encrypted.ciphertext,
      credentialIv: encrypted.iv,
      credentialAuthTag: encrypted.authTag,
      credentialLast4: last4,
      // Gravação nova é sempre v2 — inclusive quando substitui uma v1, que é
      // como uma credencial migrada é promovida ao vínculo mais forte.
      aadVersion: "v2",
      credentialUpdatedAt: new Date(),
    },
    update: {
      credentialCiphertext: encrypted.ciphertext,
      credentialIv: encrypted.iv,
      credentialAuthTag: encrypted.authTag,
      credentialLast4: last4,
      aadVersion: "v2",
      credentialUpdatedAt: new Date(),
    },
    select: { kind: true, credentialLast4: true, credentialUpdatedAt: true },
  });

  await logAudit({
    companyId,
    userId: actorUserId,
    action: "ERP_CREDENTIAL.SAVED",
    entity: "ERPCredential",
    entityId: `${provider}:${kind}`,
    // Provider e API. Nunca o token, o ciphertext, o IV, a tag — nem o last4,
    // que é fragmento do segredo.
    details: `Credencial ${provider}/${kind} gravada.`,
  });

  return {
    kind: saved.kind,
    configured: true,
    last4: saved.credentialLast4,
    updatedAt: saved.credentialUpdatedAt,
  };
}

/**
 * Remove UMA credencial. Ação explícita — campo vazio num formulário nunca
 * chega aqui.
 */
export async function removeCredentialFor(
  companyId: string,
  actorUserId: string,
  provider: ERPProvider,
  kind: ERPCredentialKind,
): Promise<void> {
  const existing = await prisma.eRPCredential.findFirst({
    where: { companyId, provider, kind },
    select: { id: true },
  });
  if (!existing) {
    throw notFound("Credencial não configurada.");
  }

  // `deleteMany` com o escopo completo, e não `delete` por id: o filtro de
  // empresa viaja junto com a escrita, em vez de depender de o id ter vindo de
  // uma leitura correta.
  await prisma.eRPCredential.deleteMany({ where: { companyId, provider, kind } });

  await logAudit({
    companyId,
    userId: actorUserId,
    action: "ERP_CREDENTIAL.REMOVED",
    entity: "ERPCredential",
    entityId: `${provider}:${kind}`,
    details: `Credencial ${provider}/${kind} removida.`,
  });
}

/**
 * Devolve o token em texto puro para uso server-side imediato.
 *
 * `null` quando não configurada — o chamador decide se isso é erro. Nunca
 * lança por ausência, porque "esta empresa não usa o Chatbot" é estado
 * legítimo, não falha.
 */
export async function getCredentialFor(
  companyId: string,
  provider: ERPProvider,
  kind: ERPCredentialKind,
): Promise<string | null> {
  const row = await prisma.eRPCredential.findFirst({
    where: { companyId, provider, kind },
    select: {
      companyId: true,
      provider: true,
      kind: true,
      aadVersion: true,
      credentialCiphertext: true,
      credentialIv: true,
      credentialAuthTag: true,
    },
  });

  if (!row) {
    return null;
  }

  /**
   * O AAD é reconstruído da identidade real da linha. Um ciphertext
   * transplantado de outra empresa, de outro provider ou — a partir do v2 — de
   * outra API verifica contra ESTA identidade e falha. Não existe fallback sem
   * vínculo: aceitá-lo manteria vivo justamente o vetor que o AAD fecha.
   */
  return decryptCredential(
    {
      ciphertext: row.credentialCiphertext,
      iv: row.credentialIv,
      authTag: row.credentialAuthTag,
    },
    aadContextFor(row),
  );
}
