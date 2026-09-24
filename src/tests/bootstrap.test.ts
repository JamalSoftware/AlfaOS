import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import {
  assertEmptyInstallation,
  BOOTSTRAP_AUDIT_ACTION,
  bootstrapTenant,
  readInstallationInventory,
} from "@/lib/bootstrap";
import { prisma } from "@/lib/prisma";
import { assertSeedAllowed } from "@/lib/seed-guard";
import { verifyPassword } from "@/lib/password";
import { resolveTimezone } from "@/lib/workday";
import { apiRequest, resetDatabase, seedTestData } from "./helpers";

/**
 * `APP-001` — a instalação ganha a primeira empresa e o primeiro ADMIN.
 *
 * A operação é definida sobre a base VAZIA, e é por isso que estes testes
 * chamam `resetDatabase()` em vez de `seedTestData()`: a fixture padrão cria
 * duas empresas e seis usuários, que é exatamente o estado em que o comando
 * tem de recusar.
 */

const RAIZ = path.resolve(__dirname, "../..");
const SCRIPT = path.join(RAIZ, "scripts", "bootstrap-tenant.ts");
const TSX = path.join(RAIZ, "node_modules", "tsx", "dist", "cli.mjs");

const SENHA = "Bootstrap@2026";
const EMAIL = "admin@provedor.com.br";

const ENTRADA = {
  companyName: "Provedor Piloto",
  document: "11.222.333/0001-44",
  adminName: "Maria Silva",
  adminEmail: EMAIL,
  password: SENHA,
  timezone: "America/Manaus",
};

function rodarCli(
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): { status: number | null; saida: string } {
  const r = spawnSync(process.execPath, [TSX, SCRIPT, ...args], {
    cwd: RAIZ,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: r.status, saida: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

beforeEach(async () => {
  await resetDatabase();
});

describe("BOOT-01 — base vazia cria empresa e ADMIN", () => {
  it("cria exatamente uma empresa e um ADMIN ativo", async () => {
    const r = await bootstrapTenant(ENTRADA);

    expect(r.dryRun).toBe(false);
    expect(r.companyId).toBeTruthy();
    expect(r.userId).toBeTruthy();

    const empresas = await prisma.company.findMany();
    expect(empresas).toHaveLength(1);
    expect(empresas[0]).toMatchObject({
      name: "Provedor Piloto",
      document: "11.222.333/0001-44",
      timezone: "America/Manaus",
      ctoNetworkEnabled: false,
    });

    const usuarios = await prisma.user.findMany();
    expect(usuarios).toHaveLength(1);
    expect(usuarios[0]).toMatchObject({
      companyId: empresas[0].id,
      email: EMAIL,
      name: "Maria Silva",
      profile: "ADMIN",
      active: true,
    });

    // Hash canônico: a senha em claro nunca é gravada, e o hash é o do bcrypt
    // do projeto (`$2a$12$…`), não um esquema próprio.
    expect(usuarios[0].passwordHash).not.toContain(SENHA);
    expect(usuarios[0].passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(await verifyPassword(SENHA, usuarios[0].passwordHash)).toBe(true);
  });

  it("grava a trilha de auditoria da inicialização, sem e-mail nem senha", async () => {
    const r = await bootstrapTenant(ENTRADA);

    const trilha = await prisma.auditLog.findMany();
    expect(trilha).toHaveLength(1);
    expect(trilha[0]).toMatchObject({
      companyId: r.companyId,
      userId: r.userId,
      action: BOOTSTRAP_AUDIT_ACTION,
      entity: "Company",
      entityId: r.companyId,
    });
    expect(trilha[0].details).not.toContain(SENHA);
    expect(trilha[0].details).not.toContain(EMAIL);
  });

  it("e-mail é normalizado para minúsculas", async () => {
    await bootstrapTenant({ ...ENTRADA, adminEmail: "  ADMIN@Provedor.COM.BR  " });
    const usuario = await prisma.user.findFirstOrThrow();
    expect(usuario.email).toBe("admin@provedor.com.br");
  });

  it("a capability de rede fica DESLIGADA quando não é pedida, e ligada quando é", async () => {
    await bootstrapTenant(ENTRADA);
    expect((await prisma.company.findFirstOrThrow()).ctoNetworkEnabled).toBe(false);

    await resetDatabase();
    await bootstrapTenant({ ...ENTRADA, ctoNetworkEnabled: true });
    expect((await prisma.company.findFirstOrThrow()).ctoNetworkEnabled).toBe(true);
  });

  it("não cria dado de amostra: nenhuma OS, tipo, cliente, técnico ou template", async () => {
    await bootstrapTenant(ENTRADA);

    expect(await prisma.serviceOrder.count()).toBe(0);
    expect(await prisma.serviceOrderType.count()).toBe(0);
    expect(await prisma.customer.count()).toBe(0);
    expect(await prisma.technician.count()).toBe(0);
    expect(await prisma.checklistTemplate.count()).toBe(0);
    expect(await prisma.inventoryItem.count()).toBe(0);
    expect(await prisma.eRPIntegration.count()).toBe(0);
  });
});

describe("BOOT-02 — o login real funciona com a senha da inicialização", () => {
  it("entra pela rota de login e recusa a senha errada", async () => {
    await bootstrapTenant(ENTRADA);

    const ok = await login(
      apiRequest("/api/auth/login", {
        method: "POST",
        body: { email: EMAIL, password: SENHA },
      }),
    );
    expect(ok.status).toBe(200);
    const cookies = ok.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("alfaos_session="))).toBe(true);
    const corpo = (await ok.json()) as {
      data: { user: { profile: string; email: string; companyId: string } };
    };
    expect(corpo.data.user.profile).toBe("ADMIN");
    expect(corpo.data.user.email).toBe(EMAIL);
    expect(corpo.data.user.companyId).toBe(
      (await prisma.company.findFirstOrThrow()).id,
    );

    const errado = await login(
      apiRequest("/api/auth/login", {
        method: "POST",
        body: { email: EMAIL, password: `${SENHA}x` },
      }),
    );
    expect(errado.status).toBe(401);
  });

  it("entra com o e-mail digitado em maiúsculas", async () => {
    await bootstrapTenant(ENTRADA);
    const res = await login(
      apiRequest("/api/auth/login", {
        method: "POST",
        body: { email: EMAIL.toUpperCase(), password: SENHA },
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe("BOOT-03 — o fuso é persistido", () => {
  it("grava o fuso pedido, e o resolvedor da jornada concorda", async () => {
    await bootstrapTenant({ ...ENTRADA, timezone: "America/Manaus" });
    const empresa = await prisma.company.findFirstOrThrow();
    expect(empresa.timezone).toBe("America/Manaus");
    expect(resolveTimezone(empresa.timezone)).toBe("America/Manaus");
  });

  it("sem fuso informado, usa o padrão do projeto", async () => {
    await bootstrapTenant({ ...ENTRADA, timezone: undefined });
    expect((await prisma.company.findFirstOrThrow()).timezone).toBe(
      "America/Sao_Paulo",
    );
  });
});

describe("BOOT-04 — a segunda execução é recusada", () => {
  it("recusa e não altera nada do que a primeira criou", async () => {
    await bootstrapTenant(ENTRADA);
    const antes = {
      empresas: await prisma.company.findMany({ orderBy: { id: "asc" } }),
      usuarios: await prisma.user.findMany({ orderBy: { id: "asc" } }),
      trilha: await prisma.auditLog.count(),
    };

    await expect(
      bootstrapTenant({
        ...ENTRADA,
        companyName: "Segundo Provedor",
        adminEmail: "outro@provedor.com.br",
        document: "99.888.777/0001-66",
      }),
    ).rejects.toThrow(/Instalação já inicializada/);

    expect(await prisma.company.findMany({ orderBy: { id: "asc" } })).toEqual(
      antes.empresas,
    );
    expect(await prisma.user.findMany({ orderBy: { id: "asc" } })).toEqual(
      antes.usuarios,
    );
    expect(await prisma.auditLog.count()).toBe(antes.trilha);
  });

  it("duas execuções simultâneas produzem UMA instalação", async () => {
    const resultados = await Promise.allSettled([
      bootstrapTenant(ENTRADA),
      bootstrapTenant({
        ...ENTRADA,
        adminEmail: "outro@provedor.com.br",
        document: "99.888.777/0001-66",
      }),
    ]);

    expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.company.count()).toBe(1);
    expect(await prisma.user.count()).toBe(1);
  });
});

describe("BOOT-05 — empresa existente recusa", () => {
  it("recusa com empresa já criada, e não cria usuário nenhum", async () => {
    await prisma.company.create({ data: { name: "Empresa Anterior" } });

    await expect(bootstrapTenant(ENTRADA)).rejects.toThrow(
      /Instalação já inicializada: empresas=1 usuarios=0/,
    );
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.company.count()).toBe(1);
  });
});

describe("BOOT-06 — usuário existente recusa", () => {
  it("recusa numa instalação povoada e NOMEIA os usuários encontrados", async () => {
    const fixture = await seedTestData();
    const usuariosAntes = await prisma.user.count();
    expect(usuariosAntes).toBeGreaterThan(0);

    const erro = await bootstrapTenant(ENTRADA).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(Error);
    // As duas contagens entram na mensagem: sem a de usuários, apagar a
    // verificação de usuários não quebraria nenhum teste, porque um usuário
    // nunca existe sem empresa e a verificação de empresa chegaria primeiro.
    expect((erro as Error).message).toContain(`usuarios=${usuariosAntes}`);
    expect((erro as Error).message).toMatch(/empresas=[1-9]/);

    expect(await prisma.user.count()).toBe(usuariosAntes);
    expect(
      await prisma.user.findFirst({ where: { companyId: fixture.companyA.id } }),
    ).toBeTruthy();
  });

  it("o guarda recusa usuários mesmo com zero empresas", () => {
    // Estado que o banco não produz — `User.companyId` é FK obrigatória —, e
    // é justamente por isso que a regra precisa de teste próprio: sem ele, a
    // verificação de usuários não teria detector nenhum, porque a de empresas
    // sempre chegaria primeiro em qualquer cenário real.
    expect(() => assertEmptyInstallation({ companies: 0, users: 3 })).toThrow(
      /usuarios=3/,
    );
    expect(() =>
      assertEmptyInstallation({ companies: 0, users: 0 }),
    ).not.toThrow();
  });
});

describe("BOOT-07 — fuso inválido não escreve nada", () => {
  it.each(["Mars/Olympus", "America/Sao Paulo", "12345"])(
    "recusa %s antes de qualquer escrita",
    async (timezone) => {
      await expect(bootstrapTenant({ ...ENTRADA, timezone })).rejects.toThrow(
        /Fuso horário inválido/,
      );
      expect(await readInstallationInventory()).toEqual({
        companies: 0,
        users: 0,
      });
    },
  );
});

describe("BOOT-08 — senha inválida não escreve nada", () => {
  it.each([
    ["curta", "1234567"],
    ["vazia", ""],
    ["longa", "a".repeat(129)],
    ["com byte nulo", "senha\u0000valida"],
  ])("recusa senha %s antes de qualquer escrita", async (_caso, password) => {
    await expect(bootstrapTenant({ ...ENTRADA, password })).rejects.toThrow();
    expect(await readInstallationInventory()).toEqual({
      companies: 0,
      users: 0,
    });
  });

  it("recusa e-mail e nome inválidos sem escrever", async () => {
    await expect(
      bootstrapTenant({ ...ENTRADA, adminEmail: "sem-arroba" }),
    ).rejects.toThrow(/E-mail do administrador inválido/);
    await expect(
      bootstrapTenant({ ...ENTRADA, companyName: "A" }),
    ).rejects.toThrow(/nome da empresa/);
    expect(await readInstallationInventory()).toEqual({
      companies: 0,
      users: 0,
    });
  });
});

describe("BOOT-09 — a senha não aparece na saída", () => {
  it("o comando real cria o ADMIN e não imprime a senha", () => {
    const r = rodarCli(
      [
        "--company",
        "Provedor CLI",
        "--admin-name",
        "Maria Silva",
        "--admin-email",
        EMAIL,
        "--timezone",
        "America/Manaus",
      ],
      { ALFAOS_BOOTSTRAP_PASSWORD: SENHA },
    );

    expect(r.status).toBe(0);
    expect(r.saida).toMatch(/\[bootstrap\] APLICADO: empresa=/);
    expect(r.saida).not.toContain(SENHA);
    expect(r.saida).not.toContain("ALFAOS_BOOTSTRAP_PASSWORD=");
  });

  it("recusa a senha em argv, e não ecoa o valor recebido", () => {
    const r = rodarCli([
      "--company",
      "Provedor CLI",
      "--admin-name",
      "Maria Silva",
      "--admin-email",
      EMAIL,
      `--password=${SENHA}`,
    ]);

    expect(r.status).toBe(2);
    expect(r.saida).toMatch(/RECUSADO: --password não é aceito/);
    expect(r.saida).not.toContain(SENHA);
  });

  it("o fonte não imprime a senha em lugar nenhum", () => {
    const fonte = readFileSync(SCRIPT, "utf8");
    for (const linha of fonte.split("\n").filter((l) => /console\./.test(l))) {
      expect(linha).not.toMatch(/\bsenha\b|password|ENV_PASSWORD\}/);
    }
  });
});

describe("BOOT-10 — dry-run não escreve", () => {
  it("valida e devolve o plano sem criar nada", async () => {
    const r = await bootstrapTenant(
      { ...ENTRADA, password: undefined },
      { dryRun: true },
    );

    expect(r.dryRun).toBe(true);
    expect(r.companyId).toBeNull();
    expect(r.userId).toBeNull();
    expect(r.timezone).toBe("America/Manaus");
    expect(await readInstallationInventory()).toEqual({
      companies: 0,
      users: 0,
    });
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("o comando real com --dry-run diz SIMULADO e não escreve", async () => {
    const r = rodarCli([
      "--company",
      "Provedor CLI",
      "--admin-name",
      "Maria Silva",
      "--admin-email",
      EMAIL,
      "--dry-run",
    ]);

    expect(r.status).toBe(0);
    expect(r.saida).toMatch(/SIMULADO — nada foi escrito/);
    expect(r.saida).not.toMatch(/APLICADO/);
    expect(await readInstallationInventory()).toEqual({
      companies: 0,
      users: 0,
    });
  });

  it("dry-run também recusa numa instalação já inicializada", async () => {
    await prisma.company.create({ data: { name: "Empresa Anterior" } });
    await expect(
      bootstrapTenant({ ...ENTRADA, password: undefined }, { dryRun: true }),
    ).rejects.toThrow(/Instalação já inicializada/);
  });
});

describe("BOOT-11 — o seed de produção continua bloqueado", () => {
  it("o guarda do seed segue recusando em produção", () => {
    expect(() => assertSeedAllowed({ NODE_ENV: "production" })).toThrow(
      /Seed recusado/,
    );
  });

  it("o seed continua chamando o guarda, e o bootstrap não o substitui", () => {
    const seed = readFileSync(path.join(RAIZ, "prisma", "seed.ts"), "utf8");
    expect(seed).toContain("assertSeedAllowed");

    // O bootstrap é outro comando: ele não importa o seed, não chama o guarda
    // e não tem senha de demonstração embutida.
    const fonte = readFileSync(path.join(RAIZ, "src", "lib", "bootstrap.ts"), "utf8");
    expect(fonte).not.toMatch(/assertSeedAllowed|seed-guard|DEMO_PASSWORD/);
    const cli = readFileSync(SCRIPT, "utf8");
    expect(cli).not.toMatch(/prisma\/seed|DEMO_PASSWORD/);
  });
});

describe("BOOT-12 — falha no meio desfaz tudo", () => {
  it("falha depois da empresa criada não deixa empresa sem ADMIN", async () => {
    await expect(
      bootstrapTenant(ENTRADA, {
        hooks: {
          afterCompanyCreate: async () => {
            throw new Error("falha simulada depois da empresa");
          },
        },
      }),
    ).rejects.toThrow(/falha simulada/);

    expect(await readInstallationInventory()).toEqual({
      companies: 0,
      users: 0,
    });
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("depois do rollback, a execução seguinte funciona", async () => {
    await bootstrapTenant(ENTRADA, {
      hooks: {
        afterCompanyCreate: async () => {
          throw new Error("falha simulada");
        },
      },
    }).catch(() => undefined);

    const r = await bootstrapTenant(ENTRADA);
    expect(r.companyId).toBeTruthy();
    expect(await prisma.company.count()).toBe(1);
    expect(await prisma.user.count()).toBe(1);
  });
});
