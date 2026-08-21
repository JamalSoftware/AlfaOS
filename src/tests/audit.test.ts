import { describe, it, expect } from "vitest";
import { sanitizeAuditDetails } from "@/lib/audit";

describe("Sanitização de auditoria", () => {
  it("remove password de details", () => {
    const result = sanitizeAuditDetails(
      "Usuário criado com password=SuperSecreto123",
    );
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("SuperSecreto123");
  });

  it("remove password_hash de details", () => {
    const result = sanitizeAuditDetails(
      "login password_hash=$2a$12$abcdefghijklmnopqrstuv",
    );
    expect(result).not.toContain("$2a$12$");
    expect(result).toContain("[REDACTED]");
  });

  it("remove tokens e secrets de details", () => {
    const details = [
      "token=eyJhbGciOiJIUzI1NiJ9.abc.def",
      "AUTH_SECRET=supersecretvalue",
      "api_key=sk-live-123456",
      "authorization=Bearer xyz.abc.123",
      "Bearer abcdefghijkl",
    ].join(" | ");
    const result = sanitizeAuditDetails(details);
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiJ9.abc.def");
    expect(result).not.toContain("supersecretvalue");
    expect(result).not.toContain("sk-live-123456");
    expect(result).not.toContain("xyz.abc.123");
    expect(result).not.toContain("abcdefghijkl");
    expect(result).toContain("[REDACTED]");
  });

  it("remove cookie de sessão de details", () => {
    const result = sanitizeAuditDetails(
      "cookie=alfaos_session=eyJhbGciOiJIUzI1NiJ9.secret",
    );
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiJ9.secret");
    expect(result).toContain("[REDACTED]");
  });

  it("retorna null quando details é nulo ou vazio", () => {
    expect(sanitizeAuditDetails(null)).toBeNull();
    expect(sanitizeAuditDetails(undefined)).toBeNull();
    expect(sanitizeAuditDetails("")).toBe("");
  });

  it("mantém conteúdo não sensível intacto", () => {
    const result = sanitizeAuditDetails(
      "Usuário criado: João da Silva (ADMIN)",
    );
    expect(result).toBe("Usuário criado: João da Silva (ADMIN)");
  });
});
