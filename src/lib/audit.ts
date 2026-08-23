import { prisma } from "./prisma";

export interface AuditLogData {
  companyId: string;
  userId?: string | null;
  action: string;
  entity?: string | null;
  entityId?: string | null;
  details?: string | null;
}

const SENSITIVE_KEY_PATTERN =
  /((?:password|password_hash|passwd|senha|auth_secret|secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|authorization|session[_-]?cookie|cookie|jwt)\s*[:=]\s*)([^,;|\n]+)/gi;

const BEARER_PATTERN = /bearer\s+\S+/gi;

/**
 * Central sanitization for everything stored in the audit log.
 *
 * Guarantees that sensitive values (passwords, hashes, tokens, secrets,
 * API keys, authorization headers, session cookies) are never persisted.
 * Over-redaction is preferred over leaks.
 */
export function sanitizeAuditDetails(
  details: string | null | undefined,
): string | null {
  if (!details) {
    return details ?? null;
  }

  let sanitized = String(details);
  sanitized = sanitized.replace(
    SENSITIVE_KEY_PATTERN,
    (_match, keyWithSeparator: string) => `${keyWithSeparator}[REDACTED]`,
  );
  sanitized = sanitized.replace(BEARER_PATTERN, "Bearer [REDACTED]");
  return sanitized;
}

function auditRow(data: AuditLogData) {
  return {
    companyId: data.companyId,
    userId: data.userId ?? null,
    action: data.action,
    entity: data.entity ?? null,
    entityId: data.entityId ?? null,
    details: sanitizeAuditDetails(data.details),
  };
}

export async function logAudit(data: AuditLogData): Promise<void> {
  try {
    await prisma.auditLog.create({ data: auditRow(data) });
  } catch (error) {
    console.error("Failed to write audit log:", error);
  }
}

/**
 * Auditoria OBRIGATÓRIA — a exceção PROPAGA.
 *
 * `logAudit` engole a falha de propósito, e para a maioria dos chamadores
 * isso está certo: a linha de auditoria é suplementar, porque a mudança de
 * estado já ficou gravada na própria entidade e na timeline. Derrubar a
 * operação por causa do registro seria pior do que perder o registro.
 *
 * A revelação de uma credencial é o caso oposto: **nada além desta linha
 * registra que o segredo saiu do servidor**. Perdê-la não é perder um
 * detalhe, é perder o fato inteiro.
 *
 * Por isso esta variante existe em vez de mudar `logAudit`: o comportamento
 * global fica intocado e nenhuma funcionalidade pré-existente muda.
 *
 * Cabe ao chamador não entregar o segredo quando isto lançar.
 */
export async function logAuditRequired(data: AuditLogData): Promise<void> {
  await prisma.auditLog.create({ data: auditRow(data) });
}
