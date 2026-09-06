import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { handleOutboxEvent } from "@/lib/outbox-handlers";
import { OUTBOX_EVENTS } from "@/lib/outbox";
import { NOTIFICATION_TYPES } from "@/lib/notifications";
import {
  resetPushProvider,
  setPushProvider,
  type PushDeliveryResult,
  type PushMessage,
  type PushNotificationProvider,
} from "@/lib/push/provider";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * # Entrega do push — o que o handler faz com a resposta do provider (`NF-1`)
 *
 * Contra Postgres real, com um provider **roteirizado**: nenhuma chamada ao
 * Firebase, nenhuma rede. O que se prova aqui é a ponte entre a resposta do
 * provider e o estado do banco — quem perde o token, quem continua alvo, e
 * quando o outbox precisa tentar de novo.
 */

/** Provider que responde o que o teste mandar, token por token. */
class PushRoteirizado implements PushNotificationProvider {
  readonly name = "roteirizado";
  readonly enviados: PushMessage[] = [];
  /** Tokens que o "FCM" recusa em definitivo. */
  invalidos = new Set<string>();
  /** Tokens que falham de forma transitória. */
  transitorios = new Set<string>();
  /** Falha da chamada INTEIRA, antes de qualquer resposta por token. */
  erroTotal = false;

  async send(message: PushMessage): Promise<PushDeliveryResult> {
    this.enviados.push(message);
    if (this.erroTotal) {
      return {
        delivered: 0,
        invalidTokens: [],
        retryableFailures: message.tokens.length,
      };
    }
    const invalidTokens = message.tokens.filter((t) => this.invalidos.has(t));
    const transitorios = message.tokens.filter((t) =>
      this.transitorios.has(t),
    ).length;
    return {
      delivered: message.tokens.length - invalidTokens.length - transitorios,
      invalidTokens,
      retryableFailures: transitorios,
    };
  }
}

let fixture: TestFixture;
let push: PushRoteirizado;

beforeEach(async () => {
  fixture = await seedTestData();
  push = new PushRoteirizado();
  setPushProvider(push);
});

afterEach(() => {
  resetPushProvider();
});

/** Um aparelho do usuário, com o token e o estado pedidos. */
async function device(options: {
  userId?: string;
  companyId?: string;
  installationId: string;
  pushToken: string | null;
  status?: "ACTIVE" | "REVOKED";
  revoked?: boolean;
}): Promise<{ id: string }> {
  return prisma.mobileDevice.create({
    data: {
      companyId: options.companyId ?? fixture.companyA.id,
      userId: options.userId ?? fixture.techA.id,
      platform: "ANDROID",
      installationId: options.installationId,
      pushToken: options.pushToken,
      status: options.status ?? "ACTIVE",
      revokedAt: options.revoked ? new Date() : null,
    },
    select: { id: true },
  });
}

/** Uma notificação para o técnico A, e o evento de outbox que a acompanha. */
async function notificacao(options: { companyId?: string; userId?: string } = {}) {
  const companyId = options.companyId ?? fixture.companyA.id;
  const n = await prisma.notification.create({
    data: {
      companyId,
      userId: options.userId ?? fixture.techA.id,
      type: NOTIFICATION_TYPES.SERVICE_ORDER_ASSIGNED,
      title: "Nova OS",
      body: "OS Nº 42 · Instalação",
      resourceType: "ServiceOrder",
      resourceId: "os-42",
    },
    select: { id: true },
  });
  return {
    companyId,
    eventType: OUTBOX_EVENTS.SERVICE_ORDER_ASSIGNED,
    aggregateType: "ServiceOrder",
    aggregateId: "os-42",
    payload: { notificationId: n.id, serviceOrderId: "os-42" },
    attempts: 1,
  };
}

async function tokenDe(id: string): Promise<string | null> {
  const d = await prisma.mobileDevice.findUniqueOrThrow({
    where: { id },
    select: { pushToken: true },
  });
  return d.pushToken;
}

// ---------------------------------------------------------------------------

describe("FCM-06 · entrega bem-sucedida", () => {
  it("envia para o aparelho e não mexe no token", async () => {
    const d = await device({ installationId: "i1", pushToken: "tok-1" });
    const ctx = await notificacao();

    await handleOutboxEvent(ctx);

    expect(push.enviados).toHaveLength(1);
    expect(push.enviados[0].tokens).toEqual(["tok-1"]);
    expect(await tokenDe(d.id)).toBe("tok-1");
  });
});

describe("FCM-07 · token inválido", () => {
  it("o token sai do aparelho, e o aparelho NÃO é revogado", async () => {
    const d = await device({ installationId: "i1", pushToken: "tok-morto" });
    push.invalidos.add("tok-morto");
    const ctx = await notificacao();

    await handleOutboxEvent(ctx);

    /*
      Token morto é fato sobre a PERMISSÃO de notificação, não sobre o direito
      de acesso. Revogar o aparelho por causa dele deslogaria o técnico no meio
      do atendimento porque ele desinstalou e reinstalou o aplicativo.
    */
    expect(await tokenDe(d.id)).toBeNull();
    const depois = await prisma.mobileDevice.findUniqueOrThrow({
      where: { id: d.id },
      select: { status: true, revokedAt: true },
    });
    expect(depois.status).toBe("ACTIVE");
    expect(depois.revokedAt).toBeNull();
  });

  it("token inválido NÃO faz o evento tentar de novo", async () => {
    await device({ installationId: "i1", pushToken: "tok-morto" });
    push.invalidos.add("tok-morto");

    // Não lança: insistir nunca faria aquele token voltar a existir.
    await expect(handleOutboxEvent(await notificacao())).resolves.toBeUndefined();
  });
});

describe("FCM-08 · falha transitória", () => {
  it("pede nova tentativa e PRESERVA o token", async () => {
    const d = await device({ installationId: "i1", pushToken: "tok-1" });
    push.transitorios.add("tok-1");

    /*
      Lançar é como o handler diz "de novo" ao outbox: `processOutboxBatch`
      devolve o evento a PENDING com backoff. Concluir em silêncio deixaria o
      técnico sem aviso e o evento marcado como processado.
    */
    await expect(handleOutboxEvent(await notificacao())).rejects.toThrow(
      /transitória/,
    );
    expect(await tokenDe(d.id)).toBe("tok-1");
  });

  it("falha da chamada inteira não condena token nenhum", async () => {
    const a = await device({ installationId: "i1", pushToken: "tok-a" });
    const b = await device({ installationId: "i2", pushToken: "tok-b" });
    push.erroTotal = true;

    await expect(handleOutboxEvent(await notificacao())).rejects.toThrow();

    // Rede caiu não é aparelho morto. Apagar tudo deixaria a empresa sem push.
    expect(await tokenDe(a.id)).toBe("tok-a");
    expect(await tokenDe(b.id)).toBe("tok-b");
  });
});

describe("FCM-09 · sucesso PARCIAL", () => {
  it("limpa o morto, mantém o vivo e ainda assim pede retry", async () => {
    const entregue = await device({ installationId: "i1", pushToken: "tok-ok" });
    const morto = await device({ installationId: "i2", pushToken: "tok-morto" });
    const tropecou = await device({ installationId: "i3", pushToken: "tok-lento" });
    push.invalidos.add("tok-morto");
    push.transitorios.add("tok-lento");

    await expect(handleOutboxEvent(await notificacao())).rejects.toThrow();

    /*
      A ORDEM é a regra desta fase, e é isto que a prova.

      A limpeza do token morto acontece ANTES da exceção. Se a exceção viesse
      primeiro, o token morto sobreviveria a cada tentativa e o evento gastaria
      as seis contra um aparelho desinstalado. Limpando antes, cada retentativa
      tem estritamente menos destinos condenados que a anterior.
    */
    expect(await tokenDe(morto.id)).toBeNull();
    expect(await tokenDe(entregue.id)).toBe("tok-ok");
    expect(await tokenDe(tropecou.id)).toBe("tok-lento");
  });

  it("a retentativa não repete o destino já condenado", async () => {
    await device({ installationId: "i1", pushToken: "tok-ok" });
    await device({ installationId: "i2", pushToken: "tok-morto" });
    push.invalidos.add("tok-morto");
    push.transitorios.add("tok-ok");
    const ctx = await notificacao();

    await expect(handleOutboxEvent(ctx)).rejects.toThrow();
    await expect(handleOutboxEvent(ctx)).rejects.toThrow();

    // A fila avança mesmo falhando: a segunda tentativa tem um alvo a menos.
    expect(push.enviados[0].tokens.sort()).toEqual(["tok-morto", "tok-ok"]);
    expect(push.enviados[1].tokens).toEqual(["tok-ok"]);
  });
});

describe("FCM-10 · nenhum aparelho elegível", () => {
  it("conclui sem enviar e sem pedir retry", async () => {
    await device({ installationId: "i1", pushToken: null });

    /*
      Não ter aparelho registrado é um estado LEGÍTIMO — técnico que ainda não
      concedeu a permissão. Tentar de novo seis vezes não faria aparecer um
      aparelho, e o evento acabaria FAILED por um não-problema.
    */
    await expect(handleOutboxEvent(await notificacao())).resolves.toBeUndefined();
    expect(push.enviados).toHaveLength(0);
  });

  it("usuário sem nenhum aparelho também conclui", async () => {
    await expect(handleOutboxEvent(await notificacao())).resolves.toBeUndefined();
    expect(push.enviados).toHaveLength(0);
  });
});

describe("FCM-11 · aparelho revogado", () => {
  it("não recebe, mesmo com token presente", async () => {
    await device({
      installationId: "i1",
      pushToken: "tok-revogado",
      status: "REVOKED",
      revoked: true,
    });
    await device({ installationId: "i2", pushToken: "tok-ativo" });

    await handleOutboxEvent(await notificacao());

    expect(push.enviados[0].tokens).toEqual(["tok-ativo"]);
  });
});

describe("FCM-13 · multi-dispositivo", () => {
  it("todos os aparelhos ativos recebem, numa chamada só", async () => {
    await device({ installationId: "i1", pushToken: "tok-a" });
    await device({ installationId: "i2", pushToken: "tok-b" });

    await handleOutboxEvent(await notificacao());

    expect(push.enviados).toHaveLength(1);
    expect(push.enviados[0].tokens.sort()).toEqual(["tok-a", "tok-b"]);
  });

  it("o mesmo token em duas linhas é enviado UMA vez", async () => {
    /*
      Acontece quando o aplicativo é reinstalado com `installationId` novo antes
      de o token antigo rotacionar. Duas mensagens iguais chegariam no mesmo
      aparelho.
    */
    const a = await device({ installationId: "i1", pushToken: "tok-x" });
    const b = await device({ installationId: "i2", pushToken: "tok-x" });

    await handleOutboxEvent(await notificacao());
    expect(push.enviados[0].tokens).toEqual(["tok-x"]);

    // E, se ele morrer, a limpeza alcança as DUAS linhas.
    push.invalidos.add("tok-x");
    await handleOutboxEvent(await notificacao());
    expect(await tokenDe(a.id)).toBeNull();
    expect(await tokenDe(b.id)).toBeNull();
  });
});

describe("FCM-14 · tenant", () => {
  it("evento da empresa A não alcança aparelho da empresa B", async () => {
    /*
      O mesmo `userId` não existe nas duas empresas, então o vetor real é uma
      linha de MobileDevice com o companyId da B apontando um usuário da A —
      representável, porque não há constraint composta.
    */
    await device({ installationId: "i1", pushToken: "tok-da-A" });
    await device({
      installationId: "i2",
      pushToken: "tok-da-B",
      companyId: fixture.companyB.id,
    });

    await handleOutboxEvent(await notificacao({ companyId: fixture.companyA.id }));

    expect(push.enviados[0].tokens).toEqual(["tok-da-A"]);
  });

  it("notificação de outra empresa não é sequer lida", async () => {
    await device({ installationId: "i1", pushToken: "tok-da-A" });
    const ctx = await notificacao({ companyId: fixture.companyA.id });

    // O worker carrega o companyId do evento; trocá-lo não deve achar nada.
    await handleOutboxEvent({ ...ctx, companyId: fixture.companyB.id });

    expect(push.enviados).toHaveLength(0);
  });
});

describe("o payload não cresce", () => {
  it("leva só identificadores, e o texto não carrega PII", async () => {
    await device({ installationId: "i1", pushToken: "tok-1" });

    await handleOutboxEvent(await notificacao());

    const enviado = push.enviados[0];
    expect(Object.keys(enviado.data ?? {}).sort()).toEqual([
      "resourceId",
      "resourceType",
      "type",
    ]);
    /*
      A prévia aparece sobre a tela bloqueada, sem autenticação, e fica dias na
      central do sistema. O número operacional identifica sem revelar.
    */
    expect(enviado.title).toBe("Nova OS");
    expect(enviado.body).toBe("OS Nº 42 · Instalação");
  });
});
