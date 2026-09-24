import { AccessProfile, type Prisma } from "@prisma/client";
import { logAuditWithin } from "./audit";
import { badRequest, conflict } from "./errors";
import { hashPassword } from "./password";
import { prisma } from "./prisma";
import { DEFAULT_TIMEZONE, isValidTimezone } from "./workday";

/**
 * # Inicialização da instalação — a primeira empresa e o primeiro ADMIN
 *
 * `APP-001`. Uma base de produção recém-migrada não tinha como ganhar a
 * primeira empresa nem o primeiro ADMIN: criar usuário exige um ADMIN de
 * sessão, criar empresa não tem rota nenhuma, e o seed de demonstração
 * **recusa** em produção (`RC-OPS-04`) — corretamente, porque ele cria contas
 * com senha conhecida escrita no código-fonte. O resultado era uma instalação
 * em que ninguém conseguia entrar, e o único caminho restante era SQL na mão,
 * com um hash de bcrypt montado por fora.
 *
 * Este módulo é a operação que faltava, e **só** ela: uma empresa, um ADMIN, o
 * fuso e a capability inicial. Não é cadastro de empresas, não é Super Admin e
 * não substitui o seed — o seed continua sendo de desenvolvimento e continua
 * recusando em produção.
 *
 * ## Uma vez, e só uma
 *
 * A operação é definida sobre a instalação VAZIA: existindo empresa ou usuário,
 * ela recusa. Isso é o que a torna segura de deixar instalada e documentada —
 * um segundo `npm run tenant:bootstrap` não cria um segundo tenant, não
 * reativa ninguém e não troca senha de ninguém. Para isso existem as telas de
 * `/usuarios`, que já são auditadas.
 *
 * A contagem é GLOBAL, e não por empresa, porque a pergunta é "esta instalação
 * já foi inicializada?". Um escopo por empresa responderia outra pergunta e
 * transformaria o comando em criação de tenant — que é escopo recusado aqui.
 *
 * ## Por que a autoridade é a mesma do resto
 *
 * Senha por `hashPassword` (bcrypt, 12 rounds, o mesmo caminho do login);
 * fuso validado por `isValidTimezone`, de `workday.ts`, que é quem já decide o
 * dia operacional; capability na coluna `Company.ctoNetworkEnabled`, que é a
 * autoridade da §8.19. Nenhum segundo lugar guarda qualquer um dos três.
 */

/** Ação de auditoria da inicialização. */
export const BOOTSTRAP_AUDIT_ACTION = "COMPANY.BOOTSTRAPPED";

/**
 * A mesma faixa da criação de usuário pela web (`POST /api/users`).
 *
 * Um mínimo próprio aqui significaria que a senha do primeiro ADMIN obedece a
 * uma regra que a tela de usuários não conhece — duas políticas para o mesmo
 * campo, e a mais frouxa vencendo por ser a de quem nasce primeiro.
 */
export const BOOTSTRAP_PASSWORD_MIN = 8;
export const BOOTSTRAP_PASSWORD_MAX = 128;

const NAME_MIN = 2;
const NAME_MAX = 120;
const EMAIL_MAX = 255;
const DOCUMENT_MAX = 32;

/** Formato conservador de e-mail: sem espaço, um `@`, domínio com ponto. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export interface BootstrapTenantInput {
  companyName: string;
  document?: string | null;
  adminName: string;
  adminEmail: string;
  /** Obrigatória fora do `dryRun`. Nunca é registrada, logada nem devolvida. */
  password?: string;
  timezone?: string | null;
  ctoNetworkEnabled?: boolean;
}

/** O que a operação vai criar — sem nada derivado da senha. */
export interface BootstrapPlan {
  companyName: string;
  document: string | null;
  adminName: string;
  adminEmail: string;
  timezone: string;
  ctoNetworkEnabled: boolean;
}

export interface BootstrapResult extends BootstrapPlan {
  dryRun: boolean;
  /** `null` no `dryRun` — nada foi escrito, então não há id. */
  companyId: string | null;
  userId: string | null;
}

export interface InstallationInventory {
  companies: number;
  users: number;
}

/**
 * Ganchos de falha — **somente teste** (`BOOT-12`).
 *
 * Existem porque a garantia a provar é a da transação: uma falha depois da
 * empresa criada não pode deixar empresa sem ADMIN. Sem o gancho, provocar
 * essa falha exigiria um dado inválido que o próprio módulo recusa antes, e o
 * teste passaria a afirmar a validação em vez do rollback.
 *
 * Mesmo precedente do `setFileStorage`: costura de teste, inerte em produção —
 * o CLI não passa `hooks`, e nenhum caminho de produção o preenche.
 */
export interface BootstrapHooks {
  afterCompanyCreate?: (tx: Prisma.TransactionClient) => Promise<void>;
}

export interface BootstrapOptions {
  /** Valida, confere a instalação e **não escreve nada**. */
  dryRun?: boolean;
  hooks?: BootstrapHooks;
}

function assertPrintable(value: string, field: string, label: string): void {
  // `\0` atravessa qualquer validação de tamanho, chega ao Postgres e volta
  // como `22021` — erro de transporte no lugar de uma recusa nomeada.
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw badRequest(`${label} contém caractere de controle.`, field);
  }
}

function requireText(
  raw: unknown,
  field: string,
  label: string,
  min: number,
  max: number,
): string {
  if (typeof raw !== "string") {
    throw badRequest(`${label} é obrigatório.`, field);
  }
  const value = raw.trim();
  if (value.length < min || value.length > max) {
    throw badRequest(
      `${label} deve ter entre ${min} e ${max} caracteres.`,
      field,
    );
  }
  assertPrintable(value, field, label);
  return value;
}

/**
 * Valida a entrada inteira ANTES de qualquer hash e de qualquer transação.
 *
 * A ordem é o requisito: fuso inválido e senha inválida precisam sair com
 * **zero escrita** (`BOOT-07`, `BOOT-08`). Validar no meio da transação faria a
 * recusa depender do rollback; validar aqui faz a recusa acontecer antes de a
 * primeira linha existir.
 */
export function validateBootstrapInput(
  input: BootstrapTenantInput,
  options: { requirePassword: boolean },
): { plan: BootstrapPlan; password: string | null } {
  const companyName = requireText(
    input.companyName,
    "companyName",
    "O nome da empresa",
    NAME_MIN,
    NAME_MAX,
  );
  const adminName = requireText(
    input.adminName,
    "adminName",
    "O nome do administrador",
    NAME_MIN,
    NAME_MAX,
  );

  const emailRaw = requireText(
    input.adminEmail,
    "adminEmail",
    "O e-mail do administrador",
    3,
    EMAIL_MAX,
  );
  // Minúsculas, como `createCompanyUser` grava e como o login procura: um
  // ADMIN gravado com maiúscula simplesmente não conseguiria entrar.
  const adminEmail = emailRaw.toLowerCase();
  if (!EMAIL_SHAPE.test(adminEmail)) {
    throw badRequest("E-mail do administrador inválido.", "adminEmail");
  }

  let document: string | null = null;
  if (input.document !== undefined && input.document !== null) {
    const trimmed = String(input.document).trim();
    // Vazio vira `null`, e não `""`: `Company.document` é único, e uma string
    // vazia gravada aqui colidiria com a próxima empresa sem documento.
    if (trimmed.length > 0) {
      document = requireText(
        trimmed,
        "document",
        "O documento da empresa",
        1,
        DOCUMENT_MAX,
      );
    }
  }

  const timezone =
    input.timezone === undefined ||
    input.timezone === null ||
    String(input.timezone).trim().length === 0
      ? DEFAULT_TIMEZONE
      : String(input.timezone).trim();
  if (!isValidTimezone(timezone)) {
    throw badRequest(
      `Fuso horário inválido: use um nome IANA (ex.: ${DEFAULT_TIMEZONE}).`,
      "timezone",
    );
  }

  let password: string | null = null;
  if (options.requirePassword || input.password !== undefined) {
    const raw = input.password;
    if (typeof raw !== "string" || raw.length === 0) {
      throw badRequest("A senha do administrador é obrigatória.", "password");
    }
    // Sem `trim`: espaço no meio é senha válida, e cortar as pontas em
    // silêncio gravaria uma senha diferente da que a pessoa digitou.
    if (raw.length < BOOTSTRAP_PASSWORD_MIN || raw.length > BOOTSTRAP_PASSWORD_MAX) {
      throw badRequest(
        `A senha deve ter entre ${BOOTSTRAP_PASSWORD_MIN} e ${BOOTSTRAP_PASSWORD_MAX} caracteres.`,
        "password",
      );
    }
    assertPrintable(raw, "password", "A senha");
    password = raw;
  }

  return {
    plan: {
      companyName,
      document,
      adminName,
      adminEmail,
      timezone,
      ctoNetworkEnabled: input.ctoNetworkEnabled === true,
    },
    password,
  };
}

/** Quantas empresas e quantos usuários existem na instalação. */
export async function readInstallationInventory(
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<InstallationInventory> {
  const [companies, users] = await Promise.all([
    client.company.count(),
    client.user.count(),
  ]);
  return { companies, users };
}

/**
 * Recusa quando a instalação não está vazia.
 *
 * A mensagem carrega as DUAS contagens de propósito. Sem isso, a checagem de
 * usuários não teria detector próprio: um usuário só existe com uma empresa
 * (`User.companyId` é FK obrigatória), então a checagem de empresa sempre
 * chegaria primeiro e apagar a de usuários não quebraria teste nenhum.
 */
export function assertEmptyInstallation(inventory: InstallationInventory): void {
  if (inventory.companies > 0 || inventory.users > 0) {
    throw conflict(
      "Instalação já inicializada: " +
        `empresas=${inventory.companies} usuarios=${inventory.users}. ` +
        "A inicialização só roda numa base vazia — use /usuarios para criar contas.",
    );
  }
}

/**
 * Cria a primeira empresa e o primeiro ADMIN, numa transação.
 *
 * Empresa, ADMIN e auditoria vivem na MESMA transação: uma empresa sem
 * administrador seria uma instalação em que ninguém entra e que a própria
 * recusa desta função impediria de consertar.
 */
export async function bootstrapTenant(
  input: BootstrapTenantInput,
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const dryRun = options.dryRun === true;
  const { plan, password } = validateBootstrapInput(input, {
    requirePassword: !dryRun,
  });

  // Recusa barata antes do bcrypt: 12 rounds custam centenas de milissegundos,
  // e não há motivo para pagá-los numa instalação que já tem dono. A conferência
  // que vale é a de dentro da transação, sob lock.
  assertEmptyInstallation(await readInstallationInventory());

  if (dryRun) {
    return { ...plan, dryRun: true, companyId: null, userId: null };
  }

  const passwordHash = await hashPassword(password as string);

  return prisma.$transaction(async (tx) => {
    // Lock consultivo de transação, o mesmo mecanismo do consumo de estoque:
    // duas execuções simultâneas contra a base vazia leriam `empresas=0` as
    // duas e criariam dois tenants. Liberado no commit e no rollback, então um
    // processo que morra no meio não deixa a instalação travada.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('alfaos:bootstrap'), 0)`;
    assertEmptyInstallation(await readInstallationInventory(tx));

    const company = await tx.company.create({
      data: {
        name: plan.companyName,
        document: plan.document,
        timezone: plan.timezone,
        ctoNetworkEnabled: plan.ctoNetworkEnabled,
      },
    });

    if (options.hooks?.afterCompanyCreate) {
      await options.hooks.afterCompanyCreate(tx);
    }

    const user = await tx.user.create({
      data: {
        companyId: company.id,
        name: plan.adminName,
        email: plan.adminEmail,
        profile: AccessProfile.ADMIN,
        passwordHash,
      },
    });

    // `userId` é o próprio ADMIN criado: não existe outro ator, e deixar a
    // trilha sem autor esconderia quem passou a ter acesso à instalação.
    // `details` não leva e-mail nem senha — a mesma regra de `USER.CREATED`.
    await logAuditWithin(tx, {
      companyId: company.id,
      userId: user.id,
      action: BOOTSTRAP_AUDIT_ACTION,
      entity: "Company",
      entityId: company.id,
      details:
        `Instalação inicializada: empresa "${plan.companyName}" · ` +
        `ADMIN "${plan.adminName}" · fuso ${plan.timezone} · ` +
        `ctoNetworkEnabled=${plan.ctoNetworkEnabled}`,
    });

    return {
      ...plan,
      dryRun: false,
      companyId: company.id,
      userId: user.id,
    };
  });
}
