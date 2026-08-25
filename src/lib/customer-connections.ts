import {
  AccessProfile,
  type ConnectionPasswordSource,
  type ConnectionUsernameSource,
  type CustomerConnection,
} from "@prisma/client";
import { logAudit, logAuditRequired } from "./audit";
import {
  ConnectionCredentialUnavailableError,
  decryptConnectionCredential,
  encryptConnectionCredential,
  isConnectionCredentialEncryptionConfigured,
} from "./connection-credential-cipher";
import {
  badRequest,
  conflict,
  forbidden,
  isUniqueConstraintError,
  notFound,
  serviceUnavailable,
} from "./errors";
import { prisma } from "./prisma";
import { technicianExecutionIssue } from "./technicians";

/**
 * Conexões de acesso do cliente e a revelação controlada da senha.
 *
 * A senha NUNCA sai daqui por acidente: a única função que devolve plaintext é
 * `revealConnectionPasswordForOrder`, e ela exige um ator resolvido e uma OS
 * que autorize a leitura. Nenhum shape público deste módulo carrega a senha —
 * `PublicCustomerConnection` expõe apenas se ela existe.
 */

export const CONNECTION_USERNAME_MAX_LENGTH = 120;
export const CONNECTION_PASSWORD_MAX_LENGTH = 256;
export const CONNECTION_PASSWORD_MIN_LENGTH = 1;

/**
 * Status em que o técnico ainda tem necessidade operacional da senha.
 *
 * Depois de `COMPLETED` o atendimento acabou: continuar podendo revelar
 * transformaria uma OS antiga numa chave permanente para a conexão daquele
 * cliente. O técnico continua enxergando a OS concluída — só não revela a
 * senha de novo.
 */
export const REVEALABLE_ORDER_STATUSES = ["ASSIGNED", "IN_PROGRESS"] as const;

export interface PublicCustomerConnection {
  id: string;
  type: string;
  username: string;
  /**
   * Se existe senha gravada. NUNCA a senha, nem um fragmento dela.
   *
   * Um `last4` faria sentido para um token de API, onde ajuda a identificar
   * QUAL credencial está configurada; numa senha ele só vaza um quarto dela.
   */
  passwordConfigured: boolean;
  /**
   * Procedência de cada metade da credencial.
   *
   * É metadado, não segredo: dizer que a senha veio da política da empresa
   * não revela nada sobre ela. Serve ao operador para saber se pode
   * restaurar o padrão sem destruir uma senha que alguém definiu à mão.
   */
  usernameSource: ConnectionUsernameSource;
  passwordSource: ConnectionPasswordSource;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function toPublicCustomerConnection(
  connection: CustomerConnection,
): PublicCustomerConnection {
  return {
    id: connection.id,
    type: connection.type,
    username: connection.username,
    passwordConfigured: connection.credentialCiphertext !== null,
    usernameSource: connection.usernameSource,
    passwordSource: connection.passwordSource,
    active: connection.active,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

function normalizeUsername(raw: string): string {
  const username = raw.trim();
  if (username.length === 0) {
    throw badRequest("Informe o usuário da conexão.");
  }
  if (username.length > CONNECTION_USERNAME_MAX_LENGTH) {
    throw badRequest(
      `Usuário deve ter no máximo ${CONNECTION_USERNAME_MAX_LENGTH} caracteres.`,
    );
  }
  return username;
}

/**
 * Valida a senha SEM normalizar.
 *
 * Nada de `trim()`: espaço no início ou fim pode ser parte legítima de uma
 * senha, e "limpar" silenciosamente gravaria uma credencial diferente da que o
 * operador digitou — que então falharia na autenticação sem explicação.
 */
function assertValidPassword(password: string): void {
  if (password.length < CONNECTION_PASSWORD_MIN_LENGTH) {
    throw badRequest("Informe a senha da conexão.");
  }
  if (password.length > CONNECTION_PASSWORD_MAX_LENGTH) {
    throw badRequest(
      `Senha deve ter no máximo ${CONNECTION_PASSWORD_MAX_LENGTH} caracteres.`,
    );
  }
}

export interface CreateCustomerConnectionInput {
  customerId: string;
  username: string;
  /** Opcional: cadastrar o usuário antes de ter a senha é legítimo. */
  password?: string | null;
  /**
   * Procedência. Parâmetro de SERVIÇO, deliberadamente ausente do schema
   * HTTP: quem decide que uma senha é `AUTO_DOCUMENT_LAST4` é o servidor
   * que a derivou, nunca o cliente que a enviou. Aceitar isto do request
   * deixaria qualquer ADMIN marcar uma senha digitada como automática e,
   * com isso, autorizá-la a ser sobrescrita depois.
   */
  usernameSource?: ConnectionUsernameSource;
  passwordSource?: ConnectionPasswordSource;
}

export interface UpdateCustomerConnectionInput {
  username?: string;
  /** Quando presente, SUBSTITUI a senha. Nunca é devolvida em lugar nenhum. */
  password?: string;
  active?: boolean;
  /** Ver `CreateCustomerConnectionInput` — parâmetro de serviço, não de HTTP. */
  usernameSource?: ConnectionUsernameSource;
  passwordSource?: ConnectionPasswordSource;
}

export async function listCustomerConnections(
  companyId: string,
  customerId: string,
): Promise<PublicCustomerConnection[]> {
  const connections = await prisma.customerConnection.findMany({
    // Filtro por tenant em SQL, não por navegação a partir do Customer.
    where: { companyId, customerId },
    orderBy: [{ active: "desc" }, { createdAt: "asc" }],
  });
  return connections.map(toPublicCustomerConnection);
}

export async function createCustomerConnection(
  companyId: string,
  actorUserId: string,
  input: CreateCustomerConnectionInput,
): Promise<PublicCustomerConnection> {
  const username = normalizeUsername(input.username);

  const customer = await prisma.customer.findFirst({
    where: { id: input.customerId, companyId },
    select: { id: true },
  });
  if (!customer) {
    throw notFound("Cliente não encontrado nesta empresa.");
  }

  const password = input.password ?? null;
  if (password !== null) {
    assertValidPassword(password);
    // Falha ANTES de qualquer escrita: chave ausente nunca pode resultar em
    // uma conexão criada com senha em texto puro nem meio configurada.
    if (!isConnectionCredentialEncryptionConfigured()) {
      throw new ConnectionCredentialUnavailableError(
        "Criptografia de credenciais não está configurada no servidor.",
      );
    }
  }

  /**
   * A senha é cifrada em UM SEGUNDO passo porque o AAD inclui o `connectionId`,
   * que só existe depois do insert. Criar e depois atualizar dentro da mesma
   * transação mantém a linha atômica: ou nasce com a credencial completa, ou
   * não nasce.
   */
  let created: CustomerConnection;
  try {
    created = await prisma.$transaction(async (tx) => {
      const row = await tx.customerConnection.create({
        data: {
          companyId,
          customerId: customer.id,
          type: "PPPOE",
          username,
          usernameSource: input.usernameSource ?? "MANUAL",
          /**
           * Sem senha gravada, a procedência é `MANUAL`: não houve
           * derivação automática nenhuma a registrar, e marcar
           * `AUTO_*` aqui autorizaria uma sobrescrita futura de algo
           * que nunca foi automático.
           */
          passwordSource: password === null ? "MANUAL" : (input.passwordSource ?? "MANUAL"),
        },
      });
      if (password === null) return row;

      const encrypted = encryptConnectionCredential(password, {
        companyId,
        customerId: customer.id,
        connectionId: row.id,
        type: row.type,
      });
      return tx.customerConnection.update({
        where: { id: row.id },
        data: {
          credentialCiphertext: encrypted.ciphertext,
          credentialIv: encrypted.iv,
          credentialAuthTag: encrypted.authTag,
          credentialUpdatedAt: new Date(),
        },
      });
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw conflict("Já existe uma conexão com esse usuário para o cliente.");
    }
    throw error;
  }

  await logAudit({
    companyId,
    userId: actorUserId,
    action: "CUSTOMER_CONNECTION.CREATED",
    entity: "CustomerConnection",
    entityId: created.id,
    // Identificadores e um booleano. Nunca a senha, o ciphertext, o IV ou a tag.
    details: `Conexão ${created.type} criada para o cliente ${customer.id} (senha ${password === null ? "não configurada" : "configurada"})`,
  });

  return toPublicCustomerConnection(created);
}

export async function updateCustomerConnection(
  companyId: string,
  connectionId: string,
  actorUserId: string,
  input: UpdateCustomerConnectionInput,
): Promise<PublicCustomerConnection> {
  const existing = await prisma.customerConnection.findFirst({
    where: { id: connectionId, companyId },
  });
  if (!existing) {
    throw notFound("Conexão não encontrada.");
  }

  const data: {
    username?: string;
    active?: boolean;
    usernameSource?: ConnectionUsernameSource;
    passwordSource?: ConnectionPasswordSource;
    credentialCiphertext?: string;
    credentialIv?: string;
    credentialAuthTag?: string;
    credentialUpdatedAt?: Date;
  } = {};

  if (input.username !== undefined) {
    data.username = normalizeUsername(input.username);
  }
  if (input.usernameSource !== undefined) {
    data.usernameSource = input.usernameSource;
  }
  if (input.passwordSource !== undefined) {
    data.passwordSource = input.passwordSource;
  }
  if (input.active !== undefined) {
    data.active = input.active;
  }

  const replacingPassword = input.password !== undefined;
  if (replacingPassword) {
    assertValidPassword(input.password as string);
    /**
     * O AAD é reconstruído a partir da identidade REAL da linha lida do banco —
     * nunca de algo que veio do request. É isso que impede alguém de gravar uma
     * credencial vinculada a outro cliente.
     */
    const encrypted = encryptConnectionCredential(input.password as string, {
      companyId: existing.companyId,
      customerId: existing.customerId,
      connectionId: existing.id,
      type: existing.type,
    });
    data.credentialCiphertext = encrypted.ciphertext;
    data.credentialIv = encrypted.iv;
    data.credentialAuthTag = encrypted.authTag;
    data.credentialUpdatedAt = new Date();
  }

  let updated: CustomerConnection;
  try {
    updated = await prisma.customerConnection.update({
      where: { id: connectionId },
      data,
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw conflict("Já existe uma conexão com esse usuário para o cliente.");
    }
    throw error;
  }

  const changed = Object.keys(data).filter(
    (k) => !k.startsWith("credential"),
  );
  if (replacingPassword) changed.push("senha");

  await logAudit({
    companyId,
    userId: actorUserId,
    action: "CUSTOMER_CONNECTION.UPDATED",
    entity: "CustomerConnection",
    entityId: connectionId,
    // Nomes de campos alterados, nunca os valores.
    details: `Conexão atualizada: ${changed.join(", ") || "sem alteração"}`,
  });

  return toPublicCustomerConnection(updated);
}

export interface RevealActor {
  userId: string;
  profile: AccessProfile;
}

/**
 * Revela a senha de uma conexão, autorizada por uma Ordem de Serviço.
 *
 * A OS é a superfície de autorização — a mesma escolha feita para diagnóstico
 * (`docs/ERP-INTEGRATIONS.md` §7). Uma rota `/customers/:id/connections/reveal`
 * daria a qualquer técnico autenticado um oráculo sobre a base inteira de
 * clientes da empresa; escopar por OS limita a leitura ao cliente que ele já
 * está atendendo.
 *
 * Tudo que decide autorização é resolvido NO SERVIDOR: a empresa vem da sessão,
 * o técnico vem do `userId`, e o cliente vem da OS. O `connectionId` é o único
 * valor aceito do cliente HTTP, e ele é validado contra o cliente da OS — uma
 * conexão de outro cliente resulta em 404, não em 403, para não confirmar que
 * o id existe.
 */
export async function revealConnectionPasswordForOrder(
  companyId: string,
  actor: RevealActor,
  orderId: string,
  connectionId: string,
): Promise<string> {
  // DISPATCHER não recebe plaintext. Recusado antes de qualquer leitura, para
  // não virar sonda de existência de OS.
  if (actor.profile === AccessProfile.DISPATCHER) {
    throw forbidden("Seu perfil não pode revelar senhas de conexão.");
  }

  const order = await prisma.serviceOrder.findFirst({
    where: { id: orderId, companyId },
    select: { id: true, customerId: true, status: true, technicianId: true },
  });
  if (!order) {
    throw notFound("Ordem de serviço não encontrada.");
  }

  if (actor.profile === AccessProfile.TECHNICIAN) {
    const technician = await prisma.technician.findFirst({
      where: { userId: actor.userId, companyId },
      select: {
        id: true,
        companyId: true,
        active: true,
        user: { select: { companyId: true, active: true, profile: true } },
      },
    });

    /**
     * Posse ANTES de elegibilidade, deliberadamente.
     *
     * Invertida, a ordem viraria oráculo: um técnico inelegível receberia
     * 403 em toda OS existente da empresa e 404 nas inexistentes,
     * aprendendo quais ids existem. Checando a posse primeiro, não-técnico
     * e não-dono continuam recebendo o MESMO 404 da OS inexistente.
     */
    if (!technician || order.technicianId !== technician.id) {
      throw notFound("Ordem de serviço não encontrada.");
    }

    /**
     * MESMA regra de elegibilidade operacional da escrita de execução —
     * reutilizada, não copiada.
     *
     * Antes desta correção o reveal verificava apenas a posse. Um técnico
     * desativado (`Technician.active = false` com `User.active = true`,
     * estado que a API de técnicos produz normalmente) seguia extraindo a
     * senha PPPoE de todas as OS ainda atribuídas a ele, enquanto a escrita
     * de execução já lhe era negada com 403 — o ADMIN via o bloqueio
     * parcial e concluía, razoavelmente, que o acesso tinha sido revogado.
     *
     * Ler uma senha não é da mesma classe que ler um registro: produz uma
     * capacidade durável que sobrevive à revogação. Desativar um técnico
     * precisa revogá-la.
     */
    const issue = technicianExecutionIssue(companyId, technician);
    if (issue) {
      throw forbidden(issue);
    }

    if (
      !(REVEALABLE_ORDER_STATUSES as readonly string[]).includes(order.status)
    ) {
      // 403 e não 404: a OS existe e o técnico a enxerga. Esconder isso seria
      // mentir sobre um recurso que ele já acessa legitimamente.
      throw forbidden(
        "A senha só pode ser revelada enquanto o atendimento estiver em andamento.",
      );
    }
  }

  const connection = await prisma.customerConnection.findFirst({
    where: { id: connectionId, companyId },
  });
  // Conexão inexistente, de outra empresa ou de OUTRO cliente: mesmo 404.
  if (!connection || connection.customerId !== order.customerId) {
    throw notFound("Conexão não encontrada para este atendimento.");
  }
  if (!connection.active) {
    throw notFound("Conexão não encontrada para este atendimento.");
  }

  if (
    connection.credentialCiphertext === null ||
    connection.credentialIv === null ||
    connection.credentialAuthTag === null
  ) {
    throw notFound("Senha não configurada para esta conexão.");
  }

  const password = decryptConnectionCredential(
    {
      ciphertext: connection.credentialCiphertext,
      iv: connection.credentialIv,
      authTag: connection.credentialAuthTag,
    },
    // Identidade REAL da linha. Um ciphertext transplantado de outro cliente
    // falha aqui, mesmo que todas as checagens acima passem.
    {
      companyId: connection.companyId,
      customerId: connection.customerId,
      connectionId: connection.id,
      type: connection.type,
    },
  );

  /**
   * Auditoria OBRIGATÓRIA, antes de a senha sair da função.
   *
   * O decrypt já aconteceu, e não há problema nisso: o texto claro está
   * apenas em memória do servidor. O que não pode acontecer é ele chegar ao
   * cliente sem que exista registro de que chegou — esta linha é a ÚNICA
   * evidência de que o segredo foi divulgado, ao contrário de toda outra
   * auditoria do sistema, onde a mudança de estado também fica gravada na
   * própria entidade.
   *
   * Daí `logAuditRequired` e não `logAudit`: aqui a falha precisa derrubar a
   * operação em vez de ser engolida.
   *
   * O conteúdo continua sendo só identificadores. Nem a senha, nem o
   * ciphertext, nem o IV, nem a tag — e nem o `username`: ele não é
   * necessário para investigar (o `connectionId` o identifica) e é dado de
   * acesso do cliente.
   */
  try {
    await logAuditRequired({
      companyId,
      userId: actor.userId,
      action: "PPPOE_CREDENTIAL_VIEWED",
      entity: "CustomerConnection",
      entityId: connection.id,
      details: `Senha revelada · cliente ${connection.customerId} · OS ${order.id} · perfil ${actor.profile}`,
    });
  } catch (error) {
    /**
     * Registra a falha de INFRAESTRUTURA, nunca o segredo — que está em
     * escopo nesta função e jamais pode entrar num log. Só a mensagem do
     * erro do banco é impressa, e ela não contém a senha.
     */
    console.error(
      "[audit:required] falha ao registrar PPPOE_CREDENTIAL_VIEWED:",
      error instanceof Error ? error.message : "erro desconhecido",
    );
    // Sem fallback silencioso: a senha simplesmente não é devolvida.
    throw serviceUnavailable(
      "Não foi possível registrar o acesso à credencial. Tente novamente.",
    );
  }

  return password;
}
