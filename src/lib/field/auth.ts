import { createHash, randomBytes } from "node:crypto";
import type { MobileDevice, Prisma } from "@prisma/client";
import { AccessProfile } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { technicianExecutionIssue } from "@/lib/technicians";
import { FieldError } from "./errors";

/**
 * # Autenticação do Field
 *
 * ## Por que NÃO é o cookie da web
 *
 * O AlfaOS já autentica com um JWT assinado em cookie `HttpOnly`
 * (`src/lib/auth.ts`). Reusá-lo aqui seria o caminho curto, e está errado por
 * duas razões independentes:
 *
 * 1. **Aquele token não é revogável.** Ele é sem estado: quem o tem, entra,
 *    até a expiração. `docs/SECURITY.md` §8.9 exige revogação *server-side e
 *    imediata*, porque o cenário que justifica esta camada existir é celular
 *    perdido — um aparelho que não coopera, não abre o app e não devolve nada.
 *    Hoje a única forma de cortar seria trocar a senha do usuário, o que
 *    derruba os outros aparelhos dele e ainda deixa o push entregando OS ao
 *    aparelho perdido.
 * 2. **Cookie em cliente nativo é acidente esperando acontecer.** O navegador
 *    manda cookie sozinho; é daí que vem CSRF, e é por isso que toda rota
 *    mutante da web passa por `assertSameOrigin`. Um aplicativo nativo não tem
 *    origem, então essa proteção não teria como funcionar aqui.
 *
 * ## Por que NÃO é um JWT novo
 *
 * Inventar um segundo JWT — agora com `deviceId` na claim — não resolveria a
 * revogação: continuaríamos precisando consultar o banco a cada requisição
 * para saber se aquele aparelho ainda vale. E aí o JWT não está pagando por si
 * mesmo: ele existe para evitar a consulta, e a consulta acontece de qualquer
 * jeito. Sobra só a superfície extra (chave de assinatura, algoritmo, `alg:
 * none`, expiração que não é revogação).
 *
 * ## O que é
 *
 * Token **opaco**: 32 bytes aleatórios, entregues uma única vez, guardados
 * como SHA-256. Nada é derivável dele, um dump do banco não devolve acesso a
 * ninguém, e `revokedAt` tem efeito no próximo request. É a solução mínima que
 * cumpre o contrato — não a mais sofisticada.
 *
 * SHA-256 puro, e não bcrypt, de propósito: o valor já é 256 bits de entropia
 * de `randomBytes`, então não há o que um atacante adivinhe por força bruta, e
 * hash lento por requisição autenticada seria custo sem defesa. Bcrypt existe
 * em `password.ts` porque senha de gente é fraca; token sorteado não é.
 */

/** 32 bytes. Abaixo disso o token deixa de ser "impossível de adivinhar". */
const TOKEN_BYTES = 32;

/**
 * Validade do token do Field.
 *
 * Doze horas seria o turno; sete dias seria conveniente. O meio-termo é uma
 * jornada longa com folga: o técnico não é deslogado no meio do dia por causa
 * de um plantão, e um aparelho que sumiu para de valer sozinho dentro de um
 * prazo curto mesmo que ninguém tenha percebido para revogar.
 *
 * A expiração NÃO substitui a revogação — ela é a rede embaixo dela.
 */
export const FIELD_TOKEN_MAX_AGE_SECONDS = 36 * 60 * 60;

export interface IssuedFieldToken {
  /** Texto claro. Existe só nesta resposta; nunca é persistido. */
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

export function hashFieldToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function issueFieldToken(now: Date = new Date()): IssuedFieldToken {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return {
    token,
    tokenHash: hashFieldToken(token),
    expiresAt: new Date(now.getTime() + FIELD_TOKEN_MAX_AGE_SECONDS * 1000),
  };
}

/**
 * Lê o token do cabeçalho `Authorization: Bearer`.
 *
 * **Só daí.** Nunca de cookie, nunca de query string, nunca do corpo.
 *
 * - Cookie está fora porque é o que o navegador envia sozinho: aceitá-lo aqui
 *   reabriria CSRF numa superfície que hoje não tem essa classe de problema.
 * - Query string está fora porque a URL entra em log de servidor, em histórico
 *   e no `Referer` — um token ali vaza sem ninguém ser atacado.
 */
export function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

export interface FieldPrincipal {
  user: {
    id: string;
    companyId: string;
    name: string;
    email: string;
  };
  technician: {
    id: string;
    active: boolean;
    /**
     * Por que este técnico não pode ESCREVER, ou null quando pode.
     *
     * Leitura nunca é bloqueada por isto: um técnico desativado continua
     * abrindo as OS que já tinha. Mesma regra que a web aplica — vem de
     * `technicianExecutionIssue`, não de uma cópia.
     */
    executionIssue: string | null;
  };
  device: {
    id: string;
    platform: MobileDevice["platform"];
  };
}

const unauthenticated = () =>
  new FieldError("UNAUTHENTICATED", "Sessão inválida ou expirada.");

/**
 * Resolve quem está chamando, a partir do token e de mais nada.
 *
 * A cadeia inteira é re-derivada no servidor a cada requisição:
 *
 * ```text
 * Bearer  →  MobileDevice (ativo, não revogado, não expirado)
 *         →  User (ativo, perfil TECHNICIAN, mesma empresa)
 *         →  Technician (mesma empresa)
 * ```
 *
 * Nada disso é lido do que o aplicativo mandou. `companyId` sai do usuário, e
 * `technicianId` sai do vínculo — mesmo que o app envie os dois, eles são
 * ignorados. É a mesma escolha de `resolveActingTechnician` na web, e a razão
 * é idêntica: identificador vindo do cliente não prova identidade.
 *
 * O `technicianId` gravado em `MobileDevice` **não** é usado para autorizar. Ele
 * é um registro histórico de qual técnico registrou aquele aparelho; se o
 * vínculo mudar, quem manda é o vínculo atual.
 *
 * Toda recusa é o MESMO `UNAUTHENTICATED`. Distinguir "token inválido" de
 * "aparelho revogado" de "usuário desativado" contaria a quem roubou o
 * aparelho exatamente em que pé está a conta.
 */
export async function authenticateField(
  request: Request,
  now: Date = new Date(),
): Promise<FieldPrincipal> {
  const token = readBearerToken(request);
  if (!token) {
    throw unauthenticated();
  }

  const device = await prisma.mobileDevice.findUnique({
    where: { tokenHash: hashFieldToken(token) },
    include: {
      user: {
        select: {
          id: true,
          companyId: true,
          name: true,
          email: true,
          active: true,
          profile: true,
        },
      },
    },
  });

  if (
    !device ||
    device.status !== "ACTIVE" ||
    device.revokedAt !== null ||
    !device.tokenExpiresAt ||
    device.tokenExpiresAt <= now
  ) {
    throw unauthenticated();
  }

  const user = device.user;
  if (!user.active || user.profile !== AccessProfile.TECHNICIAN) {
    throw unauthenticated();
  }

  // O aparelho guarda companyId, mas quem vale é o do usuário. Se as duas
  // divergirem, algo está errado o bastante para não atender.
  if (user.companyId !== device.companyId) {
    throw unauthenticated();
  }

  const technician = await prisma.technician.findFirst({
    where: { userId: user.id, companyId: user.companyId },
    select: {
      id: true,
      active: true,
      companyId: true,
      user: { select: { companyId: true, active: true, profile: true } },
    },
  });
  if (!technician) {
    throw unauthenticated();
  }

  return {
    user: {
      id: user.id,
      companyId: user.companyId,
      name: user.name,
      email: user.email,
    },
    technician: {
      id: technician.id,
      active: technician.active,
      executionIssue: technicianExecutionIssue(user.companyId, technician),
    },
    device: { id: device.id, platform: device.platform },
  };
}

/**
 * Marca presença do aparelho.
 *
 * Deliberadamente fora do caminho de autenticação e sem `await` obrigatório do
 * lado de quem chama: é telemetria de suporte ("quando este celular apareceu
 * pela última vez"), não um controle. Falhar aqui não pode derrubar a
 * requisição do técnico — nem gerar uma escrita por leitura em horário de
 * pico, por isso só grava quando o valor está velho o suficiente para importar.
 */
const LAST_SEEN_REFRESH_MS = 5 * 60 * 1000;

export async function touchDevice(
  deviceId: string,
  lastSeenAt: Date | null,
  now: Date = new Date(),
): Promise<void> {
  if (lastSeenAt && now.getTime() - lastSeenAt.getTime() < LAST_SEEN_REFRESH_MS) {
    return;
  }
  try {
    await prisma.mobileDevice.update({
      where: { id: deviceId },
      data: { lastSeenAt: now },
    });
  } catch (error) {
    console.error(
      "[field:last-seen]",
      error instanceof Error ? error.message : "erro desconhecido",
    );
  }
}

/**
 * Exige que o técnico possa ESCREVER.
 *
 * Separado de `authenticateField` porque leitura e escrita têm portas
 * diferentes: quem foi desativado continua consultando o que já tinha, e só
 * perde a capacidade de mexer. Chamado no início de cada comando mutante.
 */
export function assertCanExecute(principal: FieldPrincipal): void {
  if (principal.technician.executionIssue) {
    throw new FieldError("FORBIDDEN", principal.technician.executionIssue);
  }
}

/** Transação do Prisma, para os comandos que precisam compor escrita. */
export type FieldTx = Prisma.TransactionClient;
