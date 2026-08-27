import { describe, it, expect, beforeEach } from "vitest";
import { POST as fieldLogin } from "@/app/api/field/v1/auth/login/route";
import { POST as fieldLogout } from "@/app/api/field/v1/auth/logout/route";
import { GET as fieldMe } from "@/app/api/field/v1/me/route";
import { POST as registerRoute } from "@/app/api/field/v1/devices/register/route";
import { GET as listOrders } from "@/app/api/field/v1/service-orders/route";
import { hashFieldToken } from "@/lib/field/auth";
import { revokeDevice } from "@/lib/field/devices";
import { prisma } from "@/lib/prisma";
import {
  TEST_PASSWORD,
  createTokenFor,
  fieldRequest,
  registerTestDevice,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * Autenticação do Field: token opaco preso a um dispositivo.
 *
 * O que estes testes protegem, em ordem de gravidade:
 *
 * 1. O cookie da web NÃO abre o Field (e vice-versa).
 * 2. Revogar um aparelho corta o acesso IMEDIATAMENTE.
 * 3. Nenhuma recusa distingue "não existe" de "não pode".
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
  await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
  });
});

async function body(response: Response) {
  return (await response.json()) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string; retryable: boolean; conflict: boolean };
  };
}

const DEVICE = {
  platform: "ANDROID" as const,
  installationId: "install-abcdef123456",
  deviceName: "Moto G",
  appVersion: "0.9.0",
};

function loginRequest(email: string, password = TEST_PASSWORD, device = DEVICE) {
  return fieldRequest("/api/field/v1/auth/login", {
    method: "POST",
    body: { email, password, device },
  });
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

describe("login do Field", () => {
  it("técnico com credencial válida recebe token e dispositivo", async () => {
    const response = await fieldLogin(loginRequest("tech@alfa.test"));
    expect(response.status).toBe(200);

    const payload = await body(response);
    expect(payload.ok).toBe(true);
    const data = payload.data as {
      token: string;
      device: { id: string };
      technician: { id: string };
    };
    expect(typeof data.token).toBe("string");
    expect(data.token.length).toBeGreaterThan(30);
    expect(data.device.id).toBeTruthy();
    expect(data.technician.id).toBeTruthy();
  });

  it("o token em claro NUNCA é persistido — só o hash", async () => {
    const response = await fieldLogin(loginRequest("tech@alfa.test"));
    const { token } = (await body(response)).data as { token: string };

    const device = await prisma.mobileDevice.findFirstOrThrow({
      where: { userId: fixture.techA.id },
    });

    // O valor guardado é o hash, e ele confere com o token entregue.
    expect(device.tokenHash).toBe(hashFieldToken(token));
    // E o texto claro não está em lugar nenhum da linha.
    expect(JSON.stringify(device)).not.toContain(token);
  });

  it("a resposta do login é no-store", async () => {
    const response = await fieldLogin(loginRequest("tech@alfa.test"));
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("o token NÃO vira cookie", async () => {
    const response = await fieldLogin(loginRequest("tech@alfa.test"));
    // Nenhum Set-Cookie: é o que elimina CSRF nesta superfície e o que obriga
    // o app a guardar o token no cofre da plataforma.
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("ADMIN não entra no Field, e a recusa é indistinguível de senha errada", async () => {
    const negado = await fieldLogin(loginRequest("admin@alfa.test"));
    const senhaErrada = await fieldLogin(
      loginRequest("tech@alfa.test", "senha-errada"),
    );

    expect(negado.status).toBe(401);
    expect(senhaErrada.status).toBe(401);

    const a = await body(negado);
    const b = await body(senhaErrada);
    expect(a.error?.code).toBe("UNAUTHENTICATED");
    // Mesma frase: um ADMIN não descobre pelo app que a conta existe.
    expect(a.error?.message).toBe(b.error?.message);
  });

  it("usuário TECHNICIAN sem cadastro de técnico é recusado igual", async () => {
    const response = await fieldLogin(loginRequest("tech2@alfa.test"));
    expect(response.status).toBe(401);
    expect((await body(response)).error?.message).toBe("Credenciais inválidas.");
  });

  it("e-mail inexistente não revela nada", async () => {
    const response = await fieldLogin(loginRequest("ninguem@alfa.test"));
    expect(response.status).toBe(401);
    expect((await body(response)).error?.message).toBe("Credenciais inválidas.");
  });

  it("relogin com o mesmo installationId reaproveita a linha e rotaciona o token", async () => {
    const primeiro = await fieldLogin(loginRequest("tech@alfa.test"));
    const tokenA = ((await body(primeiro)).data as { token: string }).token;

    const segundo = await fieldLogin(loginRequest("tech@alfa.test"));
    const tokenB = ((await body(segundo)).data as { token: string }).token;

    expect(tokenA).not.toBe(tokenB);

    // Uma instalação, uma linha.
    const devices = await prisma.mobileDevice.findMany({
      where: { userId: fixture.techA.id },
    });
    expect(devices).toHaveLength(1);

    // E o token antigo morreu no mesmo instante.
    const comAntigo = await fieldMe(
      fieldRequest("/api/field/v1/me", { token: tokenA }),
    );
    expect(comAntigo.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Fronteira entre web e Field
// ---------------------------------------------------------------------------

describe("cookie da web e token do Field não se misturam", () => {
  it("cookie de sessão web NÃO autentica no Field", async () => {
    const cookie = await createTokenFor(fixture.techA.id);

    // Monta a requisição à mão porque `fieldRequest` deliberadamente não
    // oferece cookie — o objetivo aqui é justamente provar que ele não serve.
    const request = new Request("http://localhost/api/field/v1/me", {
      headers: { Cookie: `alfaos_session=${encodeURIComponent(cookie)}` },
    });

    const response = await fieldMe(request);
    expect(response.status).toBe(401);
    expect((await body(response)).error?.code).toBe("UNAUTHENTICATED");
  });

  it("token do Field NÃO é aceito em query string", async () => {
    const { token } = await registerTestDevice(fixture.techA.id);
    const response = await fieldMe(
      new Request(`http://localhost/api/field/v1/me?token=${token}`),
    );
    expect(response.status).toBe(401);
  });

  it("Authorization malformado é recusado", async () => {
    const { token } = await registerTestDevice(fixture.techA.id);
    for (const header of [token, `Basic ${token}`, "Bearer", "Bearer   "]) {
      const response = await fieldMe(
        new Request("http://localhost/api/field/v1/me", {
          headers: { Authorization: header },
        }),
      );
      expect(response.status).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// Revogação
// ---------------------------------------------------------------------------

describe("revogação de dispositivo", () => {
  it("revogar corta o acesso na requisição seguinte", async () => {
    const { token, deviceId } = await registerTestDevice(fixture.techA.id);

    const antes = await fieldMe(fieldRequest("/api/field/v1/me", { token }));
    expect(antes.status).toBe(200);

    const revogado = await revokeDevice(
      fixture.companyA.id,
      fixture.adminA.id,
      deviceId,
    );
    expect(revogado).toBe(true);

    const depois = await fieldMe(fieldRequest("/api/field/v1/me", { token }));
    expect(depois.status).toBe(401);
  });

  it("revogar apaga o pushToken — o celular perdido para de receber prévia", async () => {
    const { deviceId } = await registerTestDevice(fixture.techA.id, {
      pushToken: "fcm-token-de-teste",
    });

    await revokeDevice(fixture.companyA.id, fixture.adminA.id, deviceId);

    const device = await prisma.mobileDevice.findUniqueOrThrow({
      where: { id: deviceId },
    });
    expect(device.pushToken).toBeNull();
    expect(device.tokenHash).toBeNull();
    expect(device.status).toBe("REVOKED");
    // A linha permanece: o histórico de qual instalação operou não é apagado.
    expect(device.registeredAt).toBeInstanceOf(Date);
  });

  it("revogação é isolada por empresa", async () => {
    const { deviceId } = await registerTestDevice(fixture.techA.id);

    const cruzado = await revokeDevice(
      fixture.companyB.id,
      fixture.adminB.id,
      deviceId,
    );
    expect(cruzado).toBe(false);

    const device = await prisma.mobileDevice.findUniqueOrThrow({
      where: { id: deviceId },
    });
    expect(device.status).toBe("ACTIVE");
  });

  it("login válido reativa um aparelho revogado", async () => {
    const first = await fieldLogin(loginRequest("tech@alfa.test"));
    const { device } = (await body(first)).data as { device: { id: string } };
    await revokeDevice(fixture.companyA.id, fixture.adminA.id, device.id);

    const again = await fieldLogin(loginRequest("tech@alfa.test"));
    expect(again.status).toBe(200);

    const row = await prisma.mobileDevice.findUniqueOrThrow({
      where: { id: device.id },
    });
    expect(row.status).toBe("ACTIVE");
    expect(row.revokedAt).toBeNull();
  });

  it("token expirado não autentica", async () => {
    const { token, deviceId } = await registerTestDevice(fixture.techA.id);
    await prisma.mobileDevice.update({
      where: { id: deviceId },
      data: { tokenExpiresAt: new Date(Date.now() - 1000) },
    });

    const response = await fieldMe(fieldRequest("/api/field/v1/me", { token }));
    expect(response.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Usuário e técnico desativados
// ---------------------------------------------------------------------------

describe("desativação corta o Field", () => {
  it("usuário desativado perde o acesso mesmo com token válido", async () => {
    const { token } = await registerTestDevice(fixture.techA.id);
    await prisma.user.update({
      where: { id: fixture.techA.id },
      data: { active: false },
    });

    const response = await fieldMe(fieldRequest("/api/field/v1/me", { token }));
    expect(response.status).toBe(401);
  });

  it("técnico desativado ainda LÊ, mas não pode executar", async () => {
    const { token } = await registerTestDevice(fixture.techA.id);
    await prisma.technician.updateMany({
      where: { userId: fixture.techA.id },
      data: { active: false },
    });

    const me = await fieldMe(fieldRequest("/api/field/v1/me", { token }));
    expect(me.status).toBe(200);

    const data = (await body(me)).data as {
      technician: { executionIssue: string | null };
      capabilities: { listOrders: boolean; startOrder: boolean };
    };
    // Leitura continua: nada já registrado é escondido.
    expect(data.capabilities.listOrders).toBe(true);
    // Escrita não.
    expect(data.capabilities.startOrder).toBe(false);
    expect(data.technician.executionIssue).toBeTruthy();

    const lista = await listOrders(
      fieldRequest("/api/field/v1/service-orders", { token }),
    );
    expect(lista.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Logout e registro de dispositivo
// ---------------------------------------------------------------------------

describe("logout e registro", () => {
  it("logout invalida o token e preserva o dispositivo", async () => {
    const { token, deviceId } = await registerTestDevice(fixture.techA.id);

    const out = await fieldLogout(
      fieldRequest("/api/field/v1/auth/logout", { method: "POST", token }),
    );
    expect(out.status).toBe(200);

    const depois = await fieldMe(fieldRequest("/api/field/v1/me", { token }));
    expect(depois.status).toBe(401);

    const device = await prisma.mobileDevice.findUniqueOrThrow({
      where: { id: deviceId },
    });
    expect(device.tokenHash).toBeNull();
    // Não foi revogado — sair do app não é perder o aparelho.
    expect(device.status).toBe("ACTIVE");
    expect(device.revokedAt).toBeNull();
  });

  it("registro atualiza pushToken e appVersion do PRÓPRIO aparelho", async () => {
    const { token, deviceId } = await registerTestDevice(fixture.techA.id);

    const response = await registerRoute(
      fieldRequest("/api/field/v1/devices/register", {
        method: "POST",
        token,
        body: { pushToken: "fcm-novo", appVersion: "0.9.1" },
      }),
    );
    expect(response.status).toBe(200);

    const device = await prisma.mobileDevice.findUniqueOrThrow({
      where: { id: deviceId },
    });
    expect(device.pushToken).toBe("fcm-novo");
    expect(device.appVersion).toBe("0.9.1");
  });

  it("pushToken null explícito apaga o registro de push", async () => {
    const { token, deviceId } = await registerTestDevice(fixture.techA.id, {
      pushToken: "fcm-antigo",
    });

    await registerRoute(
      fieldRequest("/api/field/v1/devices/register", {
        method: "POST",
        token,
        body: { pushToken: null },
      }),
    );

    const device = await prisma.mobileDevice.findUniqueOrThrow({
      where: { id: deviceId },
    });
    expect(device.pushToken).toBeNull();
  });

  it("mass assignment: o corpo não pode escolher empresa, usuário nem técnico", async () => {
    const { token, deviceId } = await registerTestDevice(fixture.techA.id);

    for (const hostil of [
      { companyId: fixture.companyB.id },
      { userId: fixture.adminB.id },
      { technicianId: "qualquer" },
      { installationId: "outra-instalacao" },
      { platform: "IOS" },
      { status: "REVOKED" },
      { tokenHash: "forjado" },
    ]) {
      const response = await registerRoute(
        fieldRequest("/api/field/v1/devices/register", {
          method: "POST",
          token,
          body: hostil,
        }),
      );
      // Schema strict: campo desconhecido é RECUSADO, não descartado em
      // silêncio. O app precisa ouvir "não", não achar que funcionou.
      expect(response.status).toBe(400);
      expect((await body(response)).error?.code).toBe("VALIDATION_ERROR");
    }

    const device = await prisma.mobileDevice.findUniqueOrThrow({
      where: { id: deviceId },
    });
    expect(device.companyId).toBe(fixture.companyA.id);
    expect(device.userId).toBe(fixture.techA.id);
    expect(device.status).toBe("ACTIVE");
  });

  it("o auditlog do registro guarda nomes de campo, nunca o token de push", async () => {
    const { token } = await registerTestDevice(fixture.techA.id);
    await registerRoute(
      fieldRequest("/api/field/v1/devices/register", {
        method: "POST",
        token,
        body: { pushToken: "fcm-segredo-que-nao-pode-vazar" },
      }),
    );

    const logs = await prisma.auditLog.findMany({
      where: { action: "FIELD.DEVICE_REGISTERED" },
    });
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain("fcm-segredo-que-nao-pode-vazar");
    expect(logs[0].details).toContain("pushToken");
  });
});
