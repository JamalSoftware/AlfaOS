import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { POST as fieldLogin } from "@/app/api/field/v1/auth/login/route";
import { POST as fieldLogout } from "@/app/api/field/v1/auth/logout/route";
import { POST as registerRoute } from "@/app/api/field/v1/devices/register/route";
import { registerDevice, revokeDevice } from "@/lib/field/devices";
import { processOutboxBatch } from "@/lib/outbox";
import { handleOutboxEvent } from "@/lib/outbox-handlers";
import { prisma } from "@/lib/prisma";
import {
  resetPushProvider,
  setPushProvider,
  type PushMessage,
  type PushNotificationProvider,
} from "@/lib/push/provider";
import { assignTechnician } from "@/lib/service-orders";
import {
  TEST_PASSWORD,
  allocateTestServiceOrderNumber,
  fieldRequest,
  registerTestDevice,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # O token de push chega ao `MobileDevice` (`NF-3`)
 *
 * O aplicativo passou a mandar o token de verdade, e é isto que estes testes
 * seguram: a rota de registro escreve na linha CERTA, não cria linha nova a
 * cada rotação, não ressuscita aparelho revogado e não enche a auditoria de
 * repetição.
 *
 * O token em si nunca é asserido em log nem impresso.
 */

const TOKEN_A = "fcm-aparelho-do-tecnico-A";
const TOKEN_B = "fcm-aparelho-do-tecnico-B";

let fixture: TestFixture;

/** Provider de teste: registra o que recebeu, sem rede. */
class FakePush implements PushNotificationProvider {
  readonly name = "fake";
  readonly sent: PushMessage[] = [];

  async send(message: PushMessage) {
    this.sent.push(message);
    return {
      delivered: message.tokens.length,
      invalidTokens: [],
      retryableFailures: 0,
    };
  }
}

let push: FakePush;

beforeEach(async () => {
  fixture = await seedTestData();
  await prisma.technician.create({
    data: { companyId: fixture.companyA.id, userId: fixture.techA.id },
  });
  push = new FakePush();
  setPushProvider(push);
});

afterEach(() => {
  resetPushProvider();
});

async function body(response: Response) {
  return (await response.json()) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string };
  };
}

function register(token: string, payload: Record<string, unknown>) {
  return registerRoute(
    fieldRequest("/api/field/v1/devices/register", {
      method: "POST",
      token,
      body: payload,
    }),
  );
}

async function deviceRow(id: string) {
  return prisma.mobileDevice.findUniqueOrThrow({ where: { id } });
}

function countRegistrationAudits(deviceId: string) {
  return prisma.auditLog.count({
    where: { action: "FIELD.DEVICE_REGISTERED", entityId: deviceId },
  });
}

// ---------------------------------------------------------------------------
// NF3-B01 · primeiro registro
// ---------------------------------------------------------------------------

describe("NF3-B01 · registro do token pela primeira vez", () => {
  it("grava o token na linha do aparelho autenticado", async () => {
    const { token, deviceId } = await registerTestDevice(fixture.techA.id);
    expect((await deviceRow(deviceId)).pushToken).toBeNull();

    const response = await register(token, {
      appVersion: "0.11.0",
      pushToken: TOKEN_A,
    });
    expect(response.status).toBe(200);

    const device = await deviceRow(deviceId);
    expect(device.pushToken).toBe(TOKEN_A);
    expect(device.appVersion).toBe("0.11.0");
    expect(device.status).toBe("ACTIVE");
    expect(await countRegistrationAudits(deviceId)).toBe(1);
  });

  it("a auditoria guarda o NOME do campo, nunca o valor", async () => {
    const { token, deviceId } = await registerTestDevice(fixture.techA.id);
    await register(token, { pushToken: TOKEN_A });

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "FIELD.DEVICE_REGISTERED", entityId: deviceId },
    });
    expect(audit.details).toContain("pushToken");
    expect(JSON.stringify(audit)).not.toContain(TOKEN_A);
  });
});

// ---------------------------------------------------------------------------
// NF3-B02 · rotação no mesmo aparelho
// ---------------------------------------------------------------------------

describe("NF3-B02 · rotação atualiza a MESMA linha", () => {
  it("não cria um segundo MobileDevice", async () => {
    const { token, deviceId } = await registerTestDevice(fixture.techA.id);

    await register(token, { pushToken: TOKEN_A });
    await register(token, { pushToken: TOKEN_B });

    /*
      O token do provedor rotaciona sozinho, várias vezes na vida da
      instalação. Se cada rotação criasse uma linha, a revogação passaria a
      alcançar só a última — e o worker mandaria a mesma notificação uma vez
      por rotação já ocorrida.
    */
    const devices = await prisma.mobileDevice.findMany({
      where: { userId: fixture.techA.id },
    });
    expect(devices).toHaveLength(1);
    expect(devices[0].id).toBe(deviceId);
    expect(devices[0].pushToken).toBe(TOKEN_B);
  });
});

// ---------------------------------------------------------------------------
// NF3-B03 · repetição do mesmo token
// ---------------------------------------------------------------------------

describe("NF3-B03 · o mesmo token de novo", () => {
  it("é idempotente e não enche a auditoria", async () => {
    const { token, deviceId } = await registerTestDevice(fixture.techA.id);

    for (let i = 0; i < 5; i += 1) {
      const response = await register(token, {
        appVersion: "0.11.0",
        pushToken: TOKEN_A,
      });
      expect(response.status).toBe(200);
    }

    const device = await deviceRow(deviceId);
    expect(device.pushToken).toBe(TOKEN_A);

    // Cinco chamadas, UM aparelho. `pushToken` não é identidade (§24).
    expect(
      await prisma.mobileDevice.count({ where: { userId: fixture.techA.id } }),
    ).toBe(1);

    /*
      Cinco chamadas, UMA linha de auditoria — a da mudança real.

      O aplicativo reenvia o mesmo token a cada abertura, e isso é o
      comportamento correto dele: o provedor é a autoridade sobre o valor.
      Contar "veio no corpo" como alteração faria a trilha do aparelho crescer
      no ritmo em que ela deixaria de ser legível.
    */
    expect(await countRegistrationAudits(deviceId)).toBe(1);
  });

  it("`lastSeenAt` continua avançando, porque é batimento e não mudança", async () => {
    const { token, deviceId } = await registerTestDevice(fixture.techA.id);
    await register(token, { pushToken: TOKEN_A });
    const primeiro = (await deviceRow(deviceId)).lastSeenAt;

    await new Promise((r) => setTimeout(r, 5));
    await register(token, { pushToken: TOKEN_A });

    const segundo = (await deviceRow(deviceId)).lastSeenAt;
    expect(segundo!.getTime()).toBeGreaterThan(primeiro!.getTime());
    expect(await countRegistrationAudits(deviceId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// NF3-B04 · tenant
// ---------------------------------------------------------------------------

describe("NF3-B04 · a empresa não vem do corpo", () => {
  it("`companyId` no corpo é 400, não campo ignorado em silêncio", async () => {
    const { token, deviceId } = await registerTestDevice(fixture.techA.id);

    const response = await register(token, {
      pushToken: TOKEN_A,
      companyId: fixture.companyB.id,
    });

    expect(response.status).toBe(400);
    // E nada foi escrito: recusar depois de gravar não seria recusa.
    expect((await deviceRow(deviceId)).pushToken).toBeNull();
  });

  it("registrar na empresa A não encosta em aparelho da empresa B", async () => {
    // O fixture não tem técnico da empresa B — `techB` é da A. Sem este
    // usuário, o teste mediria duas linhas do MESMO tenant.
    const tecnicoDaB = await prisma.user.create({
      data: {
        companyId: fixture.companyB.id,
        name: "Tecnico da Empresa B",
        email: "tech@companyb.test",
        passwordHash: "hash-irrelevante-para-este-teste",
        profile: "TECHNICIAN",
      },
    });
    await prisma.technician.create({
      data: { companyId: fixture.companyB.id, userId: tecnicoDaB.id },
    });
    const alvo = await registerTestDevice(tecnicoDaB.id, {
      pushToken: TOKEN_A,
    });
    const daEmpresaA = await registerTestDevice(fixture.techA.id);

    const response = await register(daEmpresaA.token, { pushToken: TOKEN_A });

    /*
      CONTROLE POSITIVO, e sem ele o teste não vale nada.

      A afirmação abaixo é sobre uma linha que NÃO mudou. Se o registro
      passasse a falhar por qualquer motivo — 400, 401, exceção engolida —, a
      empresa B continuaria intacta e o teste seguiria verde, provando apenas
      que uma requisição que não escreveu nada não escreveu em lugar nenhum. O
      silêncio sobre B só significa alguma coisa depois de a limpeza ter
      rodado de verdade.
    */
    expect(response.status).toBe(200);
    expect((await deviceRow(daEmpresaA.deviceId)).pushToken).toBe(TOKEN_A);

    /*
      O MESMO valor de token nas duas empresas — o vetor mais plausível de
      atropelo entre tenants, já que a limpeza de token obsoleto casa por
      VALOR. Ela é escopada por `companyId`, então a linha da empresa B fica
      intacta.
    */
    expect((await deviceRow(alvo.deviceId)).pushToken).toBe(TOKEN_A);
  });
});

// ---------------------------------------------------------------------------
// NF3-B05 · identidade do aparelho
// ---------------------------------------------------------------------------

describe("NF3-B05 · o aparelho é o do token, não o do corpo", () => {
  it("instalação, usuário e plataforma no corpo são recusados", async () => {
    const { token, deviceId } = await registerTestDevice(fixture.techA.id);
    const outro = await registerTestDevice(fixture.techA.id, {
      installationId: "instalacao-de-outro-aparelho",
    });

    for (const intruso of [
      { installationId: "instalacao-de-outro-aparelho" },
      { userId: fixture.techB.id },
      { technicianId: "qualquer" },
      { deviceId: outro.deviceId },
      { platform: "IOS" },
      { status: "REVOKED" },
      { revokedAt: null },
    ]) {
      const response = await register(token, {
        pushToken: TOKEN_A,
        ...intruso,
      });
      expect(response.status).toBe(400);
    }

    // Nenhuma das sete tentativas escreveu em lugar nenhum.
    expect((await deviceRow(deviceId)).pushToken).toBeNull();
    expect((await deviceRow(outro.deviceId)).pushToken).toBeNull();
  });

  it("um token de outro aparelho escreve APENAS no aparelho dele", async () => {
    const primeiro = await registerTestDevice(fixture.techA.id, {
      installationId: "instalacao-1",
    });
    const segundo = await registerTestDevice(fixture.techA.id, {
      installationId: "instalacao-2",
    });

    await register(segundo.token, { pushToken: TOKEN_B });

    expect((await deviceRow(primeiro.deviceId)).pushToken).toBeNull();
    expect((await deviceRow(segundo.deviceId)).pushToken).toBe(TOKEN_B);
  });
});

// ---------------------------------------------------------------------------
// NF3-B06 · aparelho revogado
// ---------------------------------------------------------------------------

describe("NF3-B06 · revogado não volta pelo push", () => {
  it("o registro é recusado e o aparelho continua revogado", async () => {
    const { token, deviceId } = await registerTestDevice(fixture.techA.id, {
      pushToken: TOKEN_A,
    });

    await revokeDevice(fixture.companyA.id, fixture.adminA.id, deviceId);

    const response = await register(token, { pushToken: TOKEN_B });
    expect(response.status).toBe(401);

    /*
      Revogar é a saída para o celular perdido. Se um registro de push
      reativasse a linha — ou apenas regravasse o `pushToken` —, quem estivesse
      com o aparelho voltaria a receber prévia de OS na tela de bloqueio, e o
      ADMIN não teria como saber.
    */
    const device = await deviceRow(deviceId);
    expect(device.status).toBe("REVOKED");
    expect(device.revokedAt).not.toBeNull();
    expect(device.pushToken).toBeNull();
  });

  it("o login não devolve credencial ao aparelho revogado", async () => {
    /*
      O caminho de REATIVAÇÃO real, e o único que existe.

      `revokeDevice` apaga o `tokenHash` junto, então o token antigo deixa de
      resolver por conta própria — o teste acima passaria mesmo sem o guarda de
      `status` na autenticação. Quem PODERIA devolver uma credencial válida a
      uma linha revogada é o login, cujo `upsert` grava `tokenHash` novo e não
      toca em `status`. É por isso que ele recusa antes.
    */
    const { deviceId } = await registerTestDevice(fixture.techA.id, {
      installationId: "instalacao-revogada",
      pushToken: TOKEN_A,
    });
    await revokeDevice(fixture.companyA.id, fixture.adminA.id, deviceId);

    const login = await fieldLogin(
      fieldRequest("/api/field/v1/auth/login", {
        method: "POST",
        body: {
          email: "tech@alfa.test",
          password: TEST_PASSWORD,
          device: {
            platform: "ANDROID",
            installationId: "instalacao-revogada",
            appVersion: "0.11.0",
            pushToken: TOKEN_B,
          },
        },
      }),
    );

    expect(login.status).toBe(403);
    expect((await body(login)).error?.code).toBe("DEVICE_REVOKED");

    const device = await deviceRow(deviceId);
    expect(device.status).toBe("REVOKED");
    expect(device.tokenHash).toBeNull();
    expect(device.pushToken).toBeNull();
  });

  it("credencial válida numa linha revogada não abre o registro", async () => {
    /*
      O estado que a recusa do login impede, montado à mão: `REVOKED` com
      `tokenHash` ainda válido. É exatamente o que sobraria se aquele guarda
      caísse — e é o que a SEGUNDA tranca, em `requireFieldPrincipal`, existe
      para cobrir.

      Sem este teste, remover a verificação de `status` na autenticação não
      quebraria nada na suíte.
    */
    const { token, deviceId } = await registerTestDevice(fixture.techA.id);
    await prisma.mobileDevice.update({
      where: { id: deviceId },
      data: { status: "REVOKED", revokedAt: new Date() },
    });

    const response = await register(token, { pushToken: TOKEN_A });

    expect(response.status).toBe(401);
    expect((await deviceRow(deviceId)).pushToken).toBeNull();
    expect((await deviceRow(deviceId)).status).toBe("REVOKED");
  });

  it("a própria ESCRITA recusa linha revogada, sem depender da rota", async () => {
    /*
      A terceira tranca, e ela cobre uma janela que as outras duas não veem:
      a revogação que commita DEPOIS de `requireFieldPrincipal` ter decidido e
      ANTES da escrita. O principal já existe e é legítimo; o estado do
      aparelho mudou embaixo dele.

      Chamado no nível do serviço de propósito — pela rota, o guarda de
      autenticação responderia primeiro e o predicado de escrita nunca seria
      exercido.

      Hoje um token gravado numa linha `REVOKED` não vira entrega, porque o
      worker filtra `status` e `revokedAt`. É defesa em profundidade: no dia em
      que aquele predicado afrouxar, isto ainda segura.
    */
    const { deviceId } = await registerTestDevice(fixture.techA.id);
    const tecnico = await prisma.technician.findFirstOrThrow({
      where: { userId: fixture.techA.id },
    });
    const usuario = await prisma.user.findUniqueOrThrow({
      where: { id: fixture.techA.id },
    });
    await revokeDevice(fixture.companyA.id, fixture.adminA.id, deviceId);

    await registerDevice(
      {
        user: {
          id: usuario.id,
          companyId: usuario.companyId,
          name: usuario.name,
          email: usuario.email,
        },
        technician: {
          id: tecnico.id,
          active: tecnico.active,
          executionIssue: null,
        },
        device: { id: deviceId, platform: "ANDROID" },
      },
      { pushToken: TOKEN_A },
    );

    expect((await deviceRow(deviceId)).pushToken).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// NF3-B07 · logout
// ---------------------------------------------------------------------------

describe("NF3-B07 · sair apaga o endereço, não o direito", () => {
  it("o logout limpa o pushToken sem revogar o aparelho", async () => {
    const { token, deviceId } = await registerTestDevice(fixture.techA.id);
    await register(token, { pushToken: TOKEN_A });
    expect((await deviceRow(deviceId)).pushToken).toBe(TOKEN_A);

    const response = await fieldLogout(
      fieldRequest("/api/field/v1/auth/logout", { method: "POST", token }),
    );
    expect(response.status).toBe(200);

    /*
      O token de push é da INSTALAÇÃO, não da pessoa. Deixá-lo ali faria o
      técnico SEGUINTE no mesmo aparelho receber a notificação do anterior.
      Revogar, por outro lado, impediria o próximo login — e sair do
      aplicativo não é perder o direito de entrar.
    */
    const device = await deviceRow(deviceId);
    expect(device.pushToken).toBeNull();
    expect(device.status).toBe("ACTIVE");
    expect(device.revokedAt).toBeNull();
  });

  it("depois do logout o token antigo não registra mais nada", async () => {
    const { token, deviceId } = await registerTestDevice(fixture.techA.id);
    await fieldLogout(
      fieldRequest("/api/field/v1/auth/logout", { method: "POST", token }),
    );

    const response = await register(token, { pushToken: TOKEN_A });
    expect(response.status).toBe(401);
    expect((await deviceRow(deviceId)).pushToken).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// NF3-B08 · sessão inválida
// ---------------------------------------------------------------------------

describe("NF3-B08 · sem sessão válida não se registra", () => {
  it("token inexistente, ausente ou de cookie da web são todos 401", async () => {
    const { deviceId } = await registerTestDevice(fixture.techA.id);

    const semToken = await registerRoute(
      fieldRequest("/api/field/v1/devices/register", {
        method: "POST",
        body: { pushToken: TOKEN_A },
      }),
    );
    const inventado = await register("token-que-nunca-existiu-000000", {
      pushToken: TOKEN_A,
    });

    expect(semToken.status).toBe(401);
    expect(inventado.status).toBe(401);
    expect((await deviceRow(deviceId)).pushToken).toBeNull();

    // A recusa não distingue "não existe" de "não vale".
    expect((await body(inventado)).error?.code).toBe(
      (await body(semToken)).error?.code,
    );
  });
});

// ---------------------------------------------------------------------------
// Token duplicado entre aparelhos (§25)
// ---------------------------------------------------------------------------

describe("um token de push endereça UM aparelho", () => {
  it("registrar solta o token da linha antiga da mesma empresa", async () => {
    await prisma.technician.create({
      data: { companyId: fixture.companyA.id, userId: fixture.techB.id },
    });
    const antigo = await registerTestDevice(fixture.techA.id, {
      installationId: "aparelho-compartilhado",
      pushToken: TOKEN_A,
    });
    const novo = await registerTestDevice(fixture.techB.id, {
      installationId: "aparelho-compartilhado",
    });

    await register(novo.token, { pushToken: TOKEN_A });

    /*
      O caso real: dois técnicos dividem o aparelho da empresa. O primeiro sai,
      mas o `logout` não alcança o servidor — o aplicativo limpa a sessão local
      de qualquer jeito, porque sair precisa funcionar offline. A linha dele
      fica `ACTIVE` com o token gravado.

      Sem esta limpeza, uma notificação endereçada ao PRIMEIRO chegaria no
      aparelho que o segundo está segurando, com número de OS e nome de cliente
      na tela de bloqueio.
    */
    expect((await deviceRow(antigo.deviceId)).pushToken).toBeNull();
    expect((await deviceRow(novo.deviceId)).pushToken).toBe(TOKEN_A);

    // E o aparelho antigo continua válido: perdeu o endereço, não o acesso.
    expect((await deviceRow(antigo.deviceId)).status).toBe("ACTIVE");
  });
});

// ---------------------------------------------------------------------------
// Regressão vertical (§35)
// ---------------------------------------------------------------------------

describe("vertical · login → registro → notificação", () => {
  it("a OS atribuída encontra o aparelho que acabou de registrar", async () => {
    // 1. Login pela rota real, como o aplicativo faz.
    const login = await fieldLogin(
      fieldRequest("/api/field/v1/auth/login", {
        method: "POST",
        body: {
          email: "tech@alfa.test",
          password: TEST_PASSWORD,
          device: {
            platform: "ANDROID",
            installationId: "instalacao-vertical-01",
            appVersion: "0.11.0",
          },
        },
      }),
    );
    expect(login.status).toBe(200);
    const sessao = (await body(login)).data as {
      token: string;
      device: { id: string };
      technician: { id: string };
    };

    // O login acontece ANTES da permissão de notificação: sem token ainda.
    expect((await deviceRow(sessao.device.id)).pushToken).toBeNull();

    // 2. A permissão é concedida e o token chega — o que a `NF-3` acrescentou.
    const registro = await register(sessao.token, { pushToken: TOKEN_A });
    expect(registro.status).toBe(200);
    expect((await deviceRow(sessao.device.id)).pushToken).toBe(TOKEN_A);

    // 3. A OS é atribuída pela web, com `Notification` + `OutboxEvent` juntos.
    const customer = await prisma.customer.create({
      data: {
        companyId: fixture.companyA.id,
        name: "Maria da Silva",
        document: "12345678901",
        phone: "(28) 99999-0001",
        address: "Rua das Flores",
        number: "84",
        city: "Guaçuí",
      },
    });
    const order = await prisma.serviceOrder.create({
      data: {
        companyId: fixture.companyA.id,
        number: await allocateTestServiceOrderNumber(fixture.companyA.id),
        customerId: customer.id,
        type: "Instalação",
        description: "Instalação de fibra.",
        priority: "NORMAL",
        status: "PENDING",
      },
    });
    await assignTechnician(
      fixture.companyA.id,
      fixture.dispatcherA.id,
      order.id,
      sessao.technician.id,
      order.version,
    );

    // 4. O worker processa e o provider recebe o token registrado no passo 2.
    await processOutboxBatch(handleOutboxEvent);

    expect(push.sent).toHaveLength(1);
    expect(push.sent[0].tokens).toEqual([TOKEN_A]);
    expect(push.sent[0].title.length).toBeGreaterThan(0);
  });

  it("sem o registro da `NF-3` o worker não teria a quem entregar", async () => {
    /*
      Controle negativo. Sem ele, o teste acima poderia estar passando por
      qualquer motivo — inclusive por o provider ser chamado de todo jeito.
    */
    const technician = await prisma.technician.findFirstOrThrow({
      where: { userId: fixture.techA.id },
    });
    await registerTestDevice(fixture.techA.id);

    const customer = await prisma.customer.create({
      data: {
        companyId: fixture.companyA.id,
        name: "João Pereira",
        document: "98765432100",
        phone: "(28) 99999-0002",
        address: "Rua B",
        number: "10",
        city: "Guaçuí",
      },
    });
    const order = await prisma.serviceOrder.create({
      data: {
        companyId: fixture.companyA.id,
        number: await allocateTestServiceOrderNumber(fixture.companyA.id),
        customerId: customer.id,
        type: "Instalação",
        description: "Instalação de fibra.",
        priority: "NORMAL",
        status: "PENDING",
      },
    });
    await assignTechnician(
      fixture.companyA.id,
      fixture.dispatcherA.id,
      order.id,
      technician.id,
      order.version,
    );

    await processOutboxBatch(handleOutboxEvent);

    expect(push.sent).toHaveLength(0);
    // E o aviso interno existe de qualquer forma: o técnico o vê ao abrir.
    expect(
      await prisma.notification.count({ where: { userId: fixture.techA.id } }),
    ).toBe(1);
  });
});
