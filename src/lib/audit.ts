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

export async function logAudit(data: AuditLogData): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        companyId: data.companyId,
        userId: data.userId ?? null,
        action: data.action,
        entity: data.entity ?? null,
        entityId: data.entityId ?? null,
        details: sanitizeAuditDetails(data.details),
      },
    });
  } catch (error) {
    console.error("Failed to write audit log:", error);
  }
}
