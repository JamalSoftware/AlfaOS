import type { ConnectionPasswordSource, PppoePasswordPolicy } from "@prisma/client";
import {
  selectPrincipalLogin,
  type ChatbotLogin,
} from "@/integrations/chatbot-enrichment";
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
 *    daquele cliente, nenhuma releitura do provider desfaz isso — nem a
 *    credencial real do Chatbot. Houve um motivo que o sistema não conhece.
 *
 * 2. **Ambiguidade não é resolvida por chute.** Nada aqui escolhe "o primeiro"
 *    de nada: nem conexão local, nem credencial do provider. Sem critério
 *    inequívoco, a automação desiste e reporta.
 *
 * Este módulo NÃO fala com o ReceitaNet e NÃO envia nada para lá. Ele consome o
 * que a consulta read-only já trouxe e grava credencial LOCAL, que é a que o
 * técnico usa. Nenhuma alteração é propagada para o provider, para o RADIUS ou
 * para o roteador.
 *
 * ## Ordem de confiança da senha
 *
 * 1. **`RECEITANET_CHATBOT`** — a senha que o provedor de fato usa. Validada em
 *    campo num cliente cuja senha era EXCEÇÃO à política, que é o caso em que a
 *    derivação erra e ninguém percebe até o técnico não conseguir conectar.
 * 2. **`MANUAL`** — intocável pela automação.
 * 3. **`AUTO_DOCUMENT_LAST4`** — palpite derivado do CPF. Fallback, e
 *    **substituível** pela credencial real quando ela aparecer: é assim que os
 *    clientes provisionados antes do Chatbot deixam de carregar um palpite.
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

/** O que o provisionamento fez. Reportado ao operador — nunca silencioso. */
export type PppoeProvisionOutcome =
  /** Conexão criada. */
  | "CREATED"
  /** Usuário do ERP mudou e a conexão o acompanhava. */
  | "USERNAME_UPDATED"
  /** Palpite da política substituído pela credencial real do provedor. */
  | "PASSWORD_UPGRADED"
  /** Credencial real mudou no provedor e a conexão acompanhou. */
  | "PASSWORD_REFRESHED"
  /** Conexão já existia e coincide com o ERP. */
  | "UNCHANGED"
  /** O provider não expôs credencial nem login. Nada a provisionar. */
  | "SKIPPED_NO_LOGIN"
  /** Usuário ou senha definidos à mão. Intocáveis por automação. */
  | "SKIPPED_MANUAL"
  /** Mais de uma conexão local, ou credencial do provider indeterminada. */
  | "SKIPPED_AMBIGUOUS"
  /** Tentou e falhou. O cliente foi importado; a credencial, não. */
  | "FAILED";

export interface ProvisionPppoeInput {
  customerId: string;
  /**
   * `login` do CallCenter. Validado operacionalmente como o usuário PPPoE, mas
   * SEM senha — o CallCenter não expõe credencial.
   */
  login: string | null;
  /** Documento do cliente, para o fallback da política da empresa. */
  document: string | null;
  /**
   * Credenciais reais vindas do Chatbot, quando disponíveis.
   *
   * Contêm senha em texto puro e são consumidas aqui, seguindo direto para a
   * cifra. Não são logadas, auditadas nem devolvidas.
   */
  chatbotLogins?: ChatbotLogin[];
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
  const selection = selectPrincipalLogin(input.chatbotLogins ?? []);

  /**
   * Chatbot devolveu mais de uma credencial sem principal inequívoco.
   *
   * Parar aqui é obrigatório: gravar qualquer uma delas a rotularia como a
   * verdade do provedor, e ela pode ser a de outra conexão do mesmo cliente.
   */
  if (selection.outcome === "AMBIGUOUS") {
    return "SKIPPED_AMBIGUOUS";
  }

  const principal = selection.outcome === "SELECTED" ? selection.login : null;
  const callCenterLogin = input.login?.trim() || null;
  const username = principal?.login ?? callCenterLogin;

  if (!username) {
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

    const company = await prisma.company.findFirst({
      where: { id: companyId },
      select: { pppoePasswordPolicy: true },
    });
    if (!company) {
      return "FAILED";
    }

    const realPassword = principal?.password ?? null;
    const usernameSource =
      principal !== null ? "RECEITANET_CHATBOT" : "RECEITANET_CALLCENTER";

    // -----------------------------------------------------------------------
    // Conexão nova
    // -----------------------------------------------------------------------
    if (existing.length === 0) {
      const password =
        realPassword ?? derivePolicyPassword(company.pppoePasswordPolicy, input.document);

      const passwordSource: ConnectionPasswordSource =
        realPassword !== null
          ? "RECEITANET_CHATBOT"
          : password !== null
            ? "AUTO_DOCUMENT_LAST4"
            : "MANUAL";

      await createCustomerConnection(companyId, actorUserId, {
        customerId: input.customerId,
        username,
        password,
        usernameSource,
        passwordSource,
      });
      return "CREATED";
    }

    // -----------------------------------------------------------------------
    // Conexão existente
    // -----------------------------------------------------------------------
    const connection = existing[0];

    const usernameIsManual = connection.usernameSource === "MANUAL";
    const usernameChanged = !usernameIsManual && connection.username !== username;

    /**
     * Existe senha ARMAZENADA nesta conexão?
     *
     * `credentialCiphertext` nulo é, no schema, a representação de "senha ainda
     * não configurada" — `username` sem senha é estado legítimo. É esse campo,
     * e não a procedência, que responde se há segredo guardado.
     */
    const hasStoredPassword = connection.credentialCiphertext !== null;

    /**
     * Senha MANUAL de verdade: alguém digitou, e existe o que proteger.
     *
     * `passwordSource` é NOT NULL com default `MANUAL`, então uma conexão
     * criada pela automação sem senha derivável nasce rotulada como manual sem
     * que ninguém tenha digitado nada. Ler a procedência sem exigir senha
     * gravada transformava esse default num bloqueio permanente: quando o
     * Chatbot trazia a credencial REAL, ela era recusada e o operador lia
     * "definida à mão" sobre uma senha que não existia (auditoria, PPPOE-01).
     *
     * A proteção não foi enfraquecida — ela passou a exigir que haja segredo a
     * proteger. Sem ciphertext não há trabalho humano a preservar.
     */
    const passwordIsManual =
      hasStoredPassword && connection.passwordSource === "MANUAL";

    /**
     * A senha decide primeiro, porque é a única que uma releitura pode
     * CORRIGIR. `MANUAL` de verdade fica de fora por construção.
     */
    const canUpgradePassword = realPassword !== null && !passwordIsManual;

    if (canUpgradePassword) {
      /**
       * Substituir `AUTO_DOCUMENT_LAST4` pela credencial real é o ponto deste
       * caminho: clientes provisionados antes do Chatbot carregam um palpite
       * derivado do CPF, e sem esta troca continuariam carregando para sempre.
       *
       * Conexão SEM senha entra pela mesma porta: preencher o vazio com a
       * credencial real é a mesma operação, e é ela que faz o técnico chegar
       * ao cliente com a senha que autentica.
       *
       * `RECEITANET_CHATBOT → RECEITANET_CHATBOT` também passa: se o provedor
       * mudou a senha, a conexão acompanha. A fonte é a mesma e a nova é mais
       * recente.
       */
      const upgraded =
        !hasStoredPassword ||
        connection.passwordSource === "AUTO_DOCUMENT_LAST4";
      // Sem senha gravada, a procedência anterior não descreve nada — a
      // auditoria registra o estado real, e não o default da coluna.
      const previousSource = hasStoredPassword
        ? connection.passwordSource
        : "SEM SENHA";

      await updateCustomerConnection(companyId, connection.id, actorUserId, {
        password: realPassword,
        passwordSource: "RECEITANET_CHATBOT",
        ...(usernameChanged ? { username, usernameSource } : {}),
      });

      await logAudit({
        companyId,
        userId: actorUserId,
        action: "CUSTOMER_CONNECTION.PASSWORD_SOURCE_CHANGED",
        entity: "CustomerConnection",
        entityId: connection.id,
        /**
         * Procedência, nunca valor. Nem o antigo, nem o novo, nem fragmento de
         * qualquer um dos dois — é senha de cliente.
         */
        details: `Origem da senha: ${previousSource} → RECEITANET_CHATBOT`,
      });

      return upgraded ? "PASSWORD_UPGRADED" : "PASSWORD_REFRESHED";
    }

    /**
     * Senha MANUAL com credencial real disponível: preservar é o desfecho
     * correto, e reportá-lo como tal deixa o operador entender por que a senha
     * do provedor não entrou.
     *
     * Só chega aqui quando existe senha gravada — ver `passwordIsManual`.
     */
    if (realPassword !== null && passwordIsManual) {
      return "SKIPPED_MANUAL";
    }

    if (usernameIsManual) {
      return "SKIPPED_MANUAL";
    }
    if (!usernameChanged) {
      return "UNCHANGED";
    }

    await updateCustomerConnection(companyId, connection.id, actorUserId, {
      username,
      usernameSource,
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
 * Calcula a senha padrão da empresa SEM gravar nada.
 *
 * Separado de `restoreDefaultPassword` para que uma rota possa validar a
 * viabilidade ANTES de começar a escrever. Sem isso, um PATCH que também
 * mudasse o usuário poderia gravar a senha e falhar no resto, deixando um
 * estado que nenhuma das duas intenções descreve.
 */
export async function resolveDefaultPassword(
  companyId: string,
  connectionId: string,
): Promise<{ password: string | null; reason?: string }> {
  const connection = await prisma.customerConnection.findFirst({
    where: { id: connectionId, companyId },
    select: { id: true, customerId: true },
  });
  if (!connection) {
    return { password: null, reason: "NOT_FOUND" };
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
    return { password: null, reason: "NOT_FOUND" };
  }
  if (company.pppoePasswordPolicy !== "DOCUMENT_LAST4") {
    return { password: null, reason: "NO_POLICY" };
  }

  const password = derivePolicyPassword(company.pppoePasswordPolicy, customer.document);
  if (password === null) {
    // Documento ausente ou que não é CPF. Sem senha é melhor que senha errada.
    return { password: null, reason: "NO_DOCUMENT" };
  }

  return { password };
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
  const resolved = await resolveDefaultPassword(companyId, connectionId);
  if (!resolved.password) {
    return { applied: false, reason: resolved.reason };
  }

  await updateCustomerConnection(companyId, connectionId, actorUserId, {
    password: resolved.password,
    passwordSource: "AUTO_DOCUMENT_LAST4",
  });
  return { applied: true };
}
