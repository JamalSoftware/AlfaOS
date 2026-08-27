import { AccessProfile, type MobilePlatform } from "@prisma/client";
import { logAudit } from "@/lib/audit";
import { DUMMY_PASSWORD_HASH, verifyPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import {
  getClientIp,
  isLoginBlocked,
  recordLoginAttempt,
} from "@/lib/rate-limit";
import { FieldError } from "./errors";
import {
  FIELD_TOKEN_MAX_AGE_SECONDS,
  issueFieldToken,
  type FieldPrincipal,
} from "./auth";

/**
 * # Login e dispositivo do Field
 *
 * Reusa a máquina anti-força-bruta da web inteira: `isLoginBlocked`,
 * `recordLoginAttempt`, o custo constante do bcrypt e o `DUMMY_PASSWORD_HASH`.
 * Uma segunda implementação aqui seria uma segunda superfície de enumeração —
 * e a que ninguém lembraria de endurecer junto.
 *
 * A recusa é sempre a MESMA frase. "Conta não existe", "não é técnico", "sem
 * cadastro de técnico" e "senha errada" são indistinguíveis de fora: qualquer
 * diferença permitiria descobrir quem trabalha na empresa a partir de um
 * aplicativo que qualquer pessoa baixa.
 */

const INVALID_CREDENTIALS = "Credenciais inválidas.";

export interface FieldDeviceInput {
  platform: MobilePlatform;
  installationId: string;
  deviceName?: string | null;
  appVersion?: string | null;
  pushToken?: string | null;
}

export interface FieldLoginResult {
  token: string;
  expiresAt: Date;
  deviceId: string;
  user: { id: string; name: string; email: string };
  technician: { id: string };
  company: { id: string; name: string };
}

/**
 * Autentica o técnico e vincula o token a UMA instalação.
 *
 * O token nasce preso ao `MobileDevice`. É isso que torna a revogação possível:
 * cortar o acesso de um celular perdido é uma linha de `UPDATE`, sem tocar na
 * senha do usuário e sem derrubar os outros aparelhos dele.
 *
 * Reinstalar o app com o mesmo `installationId` **reaproveita a linha** e
 * ROTACIONA o token — o anterior deixa de valer no mesmo instante, porque o
 * `tokenHash` é sobrescrito. Um aparelho antigo que ainda segure o token velho
 * simplesmente para de autenticar.
 */
export async function loginField(
  request: Request,
  credentials: { email: string; password: string },
  device: FieldDeviceInput,
): Promise<FieldLoginResult> {
  const email = credentials.email.toLowerCase().trim();
  const ip = getClientIp(request);

  // Antes da consulta e antes do bcrypt, como na web: identificador já
  // bloqueado não paga os ~350ms de CPU da comparação.
  if (await isLoginBlocked(email, ip)) {
    throw new FieldError(
      "RATE_LIMITED",
      "Muitas tentativas de login. Tente novamente em alguns minutos.",
    );
  }

  const user = await prisma.user.findUnique({ where: { email } });

  // Paga o custo do bcrypt mesmo sem usuário, para que o tempo de resposta não
  // revele se o e-mail existe.
  const valid = await verifyPassword(
    credentials.password,
    user?.passwordHash ?? DUMMY_PASSWORD_HASH,
  );

  const reject = async (reason: string): Promise<never> => {
    await recordLoginAttempt(email, ip, false);
    if (user) {
      await logAudit({
        companyId: user.companyId,
        userId: user.id,
        action: "FIELD.LOGIN_FAILED",
        entity: "User",
        entityId: user.id,
        details: reason,
      });
    }
    throw new FieldError("UNAUTHENTICATED", INVALID_CREDENTIALS);
  };

  if (!user) {
    await recordLoginAttempt(email, ip, false);
    throw new FieldError("UNAUTHENTICATED", INVALID_CREDENTIALS);
  }
  if (!valid) return reject("Senha inválida no Field.");
  if (!user.active) return reject("Usuário inativo tentou entrar no Field.");
  if (user.profile !== AccessProfile.TECHNICIAN) {
    // O Field é a superfície do técnico. ADMIN e DISPATCHER trabalham na web,
    // e dar-lhes um token de aplicativo ampliaria o alcance de um aparelho
    // roubado para muito além de uma carteira de OS.
    return reject("Perfil sem acesso ao Field.");
  }

  const technician = await prisma.technician.findFirst({
    where: { userId: user.id, companyId: user.companyId },
    select: { id: true, active: true },
  });
  if (!technician) return reject("Usuário sem cadastro de técnico.");
  if (!technician.active) return reject("Técnico inativo tentou entrar.");

  const company = await prisma.company.findUnique({
    where: { id: user.companyId },
    select: { id: true, name: true },
  });
  if (!company) return reject("Empresa inexistente.");

  const issued = issueFieldToken();

  const saved = await prisma.mobileDevice.upsert({
    where: {
      companyId_userId_installationId: {
        companyId: user.companyId,
        userId: user.id,
        installationId: device.installationId,
      },
    },
    create: {
      companyId: user.companyId,
      userId: user.id,
      technicianId: technician.id,
      platform: device.platform,
      installationId: device.installationId,
      deviceName: device.deviceName ?? null,
      appVersion: device.appVersion ?? null,
      pushToken: device.pushToken ?? null,
      tokenHash: issued.tokenHash,
      tokenIssuedAt: new Date(),
      tokenExpiresAt: issued.expiresAt,
      lastSeenAt: new Date(),
    },
    update: {
      technicianId: technician.id,
      platform: device.platform,
      deviceName: device.deviceName ?? null,
      appVersion: device.appVersion ?? null,
      // Só sobrescreve o push token quando o app mandou um. Um login feito
      // antes de o usuário conceder a permissão de notificação não pode apagar
      // o token que já funcionava.
      ...(device.pushToken ? { pushToken: device.pushToken } : {}),
      tokenHash: issued.tokenHash,
      tokenIssuedAt: new Date(),
      tokenExpiresAt: issued.expiresAt,
      lastSeenAt: new Date(),
      // Entrar de novo com credencial válida reativa um aparelho revogado.
      // É o caminho de recuperação: o técnico que perdeu o celular e recebeu
      // outro reinstala e trabalha, sem precisar de um ADMIN disponível.
      status: "ACTIVE",
      revokedAt: null,
    },
    select: { id: true },
  });

  await recordLoginAttempt(email, ip, true);
  await logAudit({
    companyId: user.companyId,
    userId: user.id,
    action: "FIELD.LOGIN",
    entity: "MobileDevice",
    entityId: saved.id,
    details: `Login no Field a partir de ${device.platform}`,
  });

  return {
    token: issued.token,
    expiresAt: issued.expiresAt,
    deviceId: saved.id,
    user: { id: user.id, name: user.name, email: user.email },
    technician: { id: technician.id },
    company,
  };
}

/**
 * Encerra a sessão DESTE aparelho.
 *
 * Zera o token e **preserva a linha**. O histórico de qual instalação operou
 * continua existindo, e o técnico volta com um login normal — sair do
 * aplicativo não é o mesmo que perder o aparelho.
 */
export async function logoutField(principal: FieldPrincipal): Promise<void> {
  await prisma.mobileDevice.updateMany({
    where: { id: principal.device.id, companyId: principal.user.companyId },
    data: { tokenHash: null, tokenIssuedAt: null, tokenExpiresAt: null },
  });
  await logAudit({
    companyId: principal.user.companyId,
    userId: principal.user.id,
    action: "FIELD.LOGOUT",
    entity: "MobileDevice",
    entityId: principal.device.id,
  });
}

export interface DeviceRegistrationInput {
  appVersion?: string | null;
  deviceName?: string | null;
  pushToken?: string | null;
}

/**
 * Atualiza os metadados do aparelho já autenticado.
 *
 * É por aqui que o token de push chega e rotaciona — o registro do FCM
 * acontece depois do login, quando o usuário concede a permissão, e muda
 * sozinho ao longo da vida da instalação.
 *
 * `companyId`, `userId` e `technicianId` **não** são aceitos: eles vêm do
 * principal. Um app que os enviasse estaria tentando registrar aparelho no
 * tenant de outra pessoa.
 */
export async function registerDevice(
  principal: FieldPrincipal,
  input: DeviceRegistrationInput,
): Promise<{ deviceId: string }> {
  const changed: string[] = [];
  if (input.appVersion !== undefined) changed.push("appVersion");
  if (input.deviceName !== undefined) changed.push("deviceName");
  if (input.pushToken !== undefined) changed.push("pushToken");

  await prisma.mobileDevice.updateMany({
    where: {
      id: principal.device.id,
      companyId: principal.user.companyId,
      userId: principal.user.id,
    },
    data: {
      ...(input.appVersion !== undefined
        ? { appVersion: input.appVersion }
        : {}),
      ...(input.deviceName !== undefined
        ? { deviceName: input.deviceName }
        : {}),
      ...(input.pushToken !== undefined ? { pushToken: input.pushToken } : {}),
      lastSeenAt: new Date(),
    },
  });

  if (changed.length > 0) {
    await logAudit({
      companyId: principal.user.companyId,
      userId: principal.user.id,
      action: "FIELD.DEVICE_REGISTERED",
      entity: "MobileDevice",
      entityId: principal.device.id,
      // Nomes de campos, nunca valores. Token de push não vai para lugar
      // nenhum que seja lido depois (§34).
      details: `Campos atualizados: ${changed.join(", ")}`,
    });
  }

  return { deviceId: principal.device.id };
}

/**
 * Revoga um aparelho — o caminho do celular perdido.
 *
 * Efeito **imediato**: o token deixa de resolver na próxima requisição, sem
 * depender de o aparelho estar ligado, conectado ou cooperando. O `pushToken`
 * some junto, senão o celular perdido continuaria recebendo prévia de ordem de
 * serviço na tela bloqueada.
 *
 * A linha permanece: quem revogou, quando, e qual instalação era.
 */
export async function revokeDevice(
  companyId: string,
  actorUserId: string,
  deviceId: string,
): Promise<boolean> {
  const result = await prisma.mobileDevice.updateMany({
    where: { id: deviceId, companyId, revokedAt: null },
    data: {
      status: "REVOKED",
      revokedAt: new Date(),
      tokenHash: null,
      tokenIssuedAt: null,
      tokenExpiresAt: null,
      pushToken: null,
    },
  });
  if (result.count !== 1) return false;

  await logAudit({
    companyId,
    userId: actorUserId,
    action: "FIELD.DEVICE_REVOKED",
    entity: "MobileDevice",
    entityId: deviceId,
    details: "Dispositivo revogado. Token e push invalidados.",
  });
  return true;
}

export const FIELD_TOKEN_TTL_SECONDS = FIELD_TOKEN_MAX_AGE_SECONDS;
