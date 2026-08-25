import type { ConnectionPasswordSource, PppoePasswordPolicy } from "@prisma/client";
import { logAudit } from "./audit";
import { createCustomerConnection, updateCustomerConnection } from "./customer-connections";
import { prisma } from "./prisma";

/**
 * Provisionamento automático do acesso PPPoE a partir do ERP.
 *
 * Duas regras dominam este módulo, e as duas existem para proteger o trabalho
 * humano contra a automação:
 *
 * 1. **`MANUAL` nunca é sobrescrito.** Se alguém digitou o usuário ou a senha
 *    daquele cliente, nenhuma releitura do provider desfaz isso. É o caso real
 *    da Alfa Telecom: a maioria segue a política, e uma minoria tem senha
 *    própria — que uma sincronização ingênua apagaria sem deixar rastro.
 *
 * 2. **Ambiguidade não é resolvida por chute.** Nada aqui assume que "a
 *    primeira conexão" é a certa. Com mais de uma conexão PPPoE no cliente, o
 *    provisionamento automático desiste e reporta, em vez de escolher.
 *
 * Este módulo NÃO fala com o ReceitaNet e NÃO envia nada para lá. Ele consome o
 * `login` que a consulta read-only já trouxe e grava credencial LOCAL, que é a
 * que o técnico usa. Nenhuma alteração é propagada para o provider, para o
 * RADIUS ou para o roteador.
 */

/** Só dígitos. Máscara é apresentação e não pode influenciar a derivação. */
function digitsOnly(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\D/g, "");
}

/**
 * Quatro últimos dígitos do CPF, ou `null`.
 *
 * **Exatamente 11 dígitos.** CNPJ tem 14 e NÃO ganha regra equivalente: a
 * política declarada pela Alfa Telecom fala de CPF, e estendê-la a CNPJ por
 * analogia inventaria uma credencial que ninguém definiu. Documento ausente,
 * curto, longo ou não numérico também devolve `null` — sem senha configurada é
 * um estado legítimo, senha errada não é.
 */
export function deriveDocumentLast4(document: string | null | undefined): string | null {
  const digits = digitsOnly(document);
  if (digits.length !== 11) {
    return null;
  }
  return digits.slice(-4);
}

/** Senha derivada pela política da empresa, ou `null` se ela não se aplica. */
export function derivePolicyPassword(
  policy: PppoePasswordPolicy,
  document: string | null | undefined,
): string | null {
  if (policy !== "DOCUMENT_LAST4") {
    return null;
  }
  return deriveDocumentLast4(document);
}

/**
 * O que o provisionamento fez. Reportado ao operador — nunca silencioso.
 */
export type PppoeProvisionOutcome =
  /** Conexão criada com usuário do ERP (e senha da política, se aplicável). */
  | "CREATED"
  /** Usuário do ERP mudou e a conexão o acompanhava. */
  | "USERNAME_UPDATED"
  /** Conexão já existia e coincide com o ERP. */
  | "UNCHANGED"
  /** O provider não expôs `login`. Nada a provisionar. */
  | "SKIPPED_NO_LOGIN"
  /** Usuário definido à mão. Intocável por automação. */
  | "SKIPPED_MANUAL"
  /** Mais de uma conexão PPPoE: qual seria a certa é indeterminado. */
  | "SKIPPED_AMBIGUOUS"
  /** Tentou e falhou. O cliente foi importado; a credencial, não. */
  | "FAILED";

export interface ProvisionPppoeInput {
  customerId: string;
  /** `login` do ERP. Validado operacionalmente como o usuário PPPoE. */
  login: string | null;
  /** Documento do cliente, para a política de senha. */
  document: string | null;
}

/**
 * Provisiona (ou concilia) o acesso PPPoE do cliente com o que o ERP informou.
 *
 * Nunca lança: o provisionamento é efeito colateral da importação, e derrubar a
 * importação inteira porque a credencial falhou trocaria o essencial pelo
 * acessório. Mas também não engole nada — a falha vira `FAILED`, é auditada, e
 * o chamador a reporta ao operador.
 */
export async function provisionPppoeFromErp(
  companyId: string,
  actorUserId: string,
  input: ProvisionPppoeInput,
): Promise<PppoeProvisionOutcome> {
  const login = input.login?.trim();
  if (!login) {
    return "SKIPPED_NO_LOGIN";
  }

  try {
    const existing = await prisma.customerConnection.findMany({
      // Tenant em SQL, nunca por navegação a partir do Customer.
      where: { companyId, customerId: input.customerId, type: "PPPOE" },
      orderBy: { createdAt: "asc" },
    });

    if (existing.length > 1) {
      return "SKIPPED_AMBIGUOUS";
    }

    if (existing.length === 0) {
      const company = await prisma.company.findFirst({
        where: { id: companyId },
        select: { pppoePasswordPolicy: true },
      });
      if (!company) {
        return "FAILED";
      }

      const password = derivePolicyPassword(company.pppoePasswordPolicy, input.document);
      const passwordSource: ConnectionPasswordSource =
        password === null ? "MANUAL" : "AUTO_DOCUMENT_LAST4";

      await createCustomerConnection(companyId, actorUserId, {
        customerId: input.customerId,
        username: login,
        password,
        usernameSource: "RECEITANET",
        passwordSource,
      });
      return "CREATED";
    }

    const connection = existing[0];

    /**
     * Senha existente NUNCA é recalculada aqui, nem quando a procedência é
     * automática. Uma importação repetida não é motivo legítimo para reescrever
     * credencial: o valor derivado é o mesmo, a escrita seria inútil, e no dia
     * em que o documento do cadastro for corrigido a senha mudaria sozinha,
     * derrubando o acesso de um cliente em campo sem ninguém ter pedido.
     * Recalcular é ação explícita do ADMIN ("Restaurar padrão").
     */
    if (connection.usernameSource === "MANUAL") {
      return "SKIPPED_MANUAL";
    }
    if (connection.username === login) {
      return "UNCHANGED";
    }

    await updateCustomerConnection(companyId, connection.id, actorUserId, {
      username: login,
      usernameSource: "RECEITANET",
    });
    return "USERNAME_UPDATED";
  } catch {
    /**
     * Sem detalhe do erro na auditoria: a exceção pode carregar fragmento de
     * payload do provider. O que importa registrar é que houve tentativa e ela
     * não completou.
     */
    await logAudit({
      companyId,
      userId: actorUserId,
      action: "CUSTOMER_CONNECTION.AUTO_PROVISION_FAILED",
      entity: "Customer",
      entityId: input.customerId,
      details: "Provisionamento automático de PPPoE não pôde ser concluído.",
    });
    return "FAILED";
  }
}

/**
 * Restaura a senha para o padrão da empresa. Ação explícita do ADMIN.
 *
 * É o único caminho que recalcula uma senha já existente, e por isso o único
 * que pode transformar `MANUAL` em `AUTO_DOCUMENT_LAST4` — deliberadamente,
 * porque quem clicou sabe que está descartando a senha anterior.
 */
export async function restoreDefaultPassword(
  companyId: string,
  connectionId: string,
  actorUserId: string,
): Promise<{ applied: boolean; reason?: string }> {
  const connection = await prisma.customerConnection.findFirst({
    where: { id: connectionId, companyId },
    select: { id: true, customerId: true },
  });
  if (!connection) {
    return { applied: false, reason: "NOT_FOUND" };
  }

  const [company, customer] = await Promise.all([
    prisma.company.findFirst({
      where: { id: companyId },
      select: { pppoePasswordPolicy: true },
    }),
    prisma.customer.findFirst({
      where: { id: connection.customerId, companyId },
      select: { document: true },
    }),
  ]);

  if (!company || !customer) {
    return { applied: false, reason: "NOT_FOUND" };
  }
  if (company.pppoePasswordPolicy !== "DOCUMENT_LAST4") {
    return { applied: false, reason: "NO_POLICY" };
  }

  const password = derivePolicyPassword(company.pppoePasswordPolicy, customer.document);
  if (password === null) {
    // Documento ausente ou que não é CPF. Sem senha é melhor que senha errada.
    return { applied: false, reason: "NO_DOCUMENT" };
  }

  await updateCustomerConnection(companyId, connectionId, actorUserId, {
    password,
    passwordSource: "AUTO_DOCUMENT_LAST4",
  });
  return { applied: true };
}
