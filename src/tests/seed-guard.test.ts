import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { assertSeedAllowed } from "@/lib/seed-guard";
import { prisma } from "@/lib/prisma";
import { seedTestData } from "./helpers";

/**
 * RC-OPS-04 — o seed não roda em produção.
 *
 * Ele cria (e REATIVA) usuários ADMIN com uma senha de demonstração que está no
 * código-fonte. Rodado contra a base de produção — `prisma db seed`, ou o seed
 * automático de um `migrate reset` —, entregaria acesso administrativo a quem
 * conhece o repositório.
 */

const RAIZ = path.resolve(__dirname, "../..");
const SEED = path.join(RAIZ, "prisma", "seed.ts");
const TSX = path.join(RAIZ, "node_modules", "tsx", "dist", "cli.mjs");

beforeEach(async () => {
  await seedTestData();
});

describe("assertSeedAllowed", () => {
  it("em produção, recusa", () => {
    expect(() => assertSeedAllowed({ NODE_ENV: "production" })).toThrow(/Seed recusado/);
  });

  it("fora de produção, deixa passar (desenvolvimento e o banco do E2E)", () => {
    expect(() => assertSeedAllowed({ NODE_ENV: "development" })).not.toThrow();
    expect(() => assertSeedAllowed({ NODE_ENV: "test" })).not.toThrow();
    expect(() => assertSeedAllowed({})).not.toThrow();
  });
});

describe("o script de seed", () => {
  it("com NODE_ENV=production sai com erro ANTES de escrever qualquer coisa", async () => {
    const antes = {
      usuarios: await prisma.user.count(),
      empresas: await prisma.company.findMany({ select: { id: true, updatedAt: true }, orderBy: { id: "asc" } }),
    };

    const r = spawnSync(process.execPath, [TSX, SEED], {
      cwd: RAIZ,
      env: { ...process.env, NODE_ENV: "production" },
      encoding: "utf8",
      timeout: 60_000,
    });

    expect(r.status).toBe(1);
    expect(`${r.stderr}${r.stdout}`).toMatch(/Seed recusado/);
    expect(r.stdout).not.toMatch(/Seed complete/);

    // O seed faz upsert das empresas de demonstração (o que mexeria em
    // `updatedAt`) e cria os usuários: nada disso pode ter acontecido.
    expect(await prisma.user.count()).toBe(antes.usuarios);
    expect(
      await prisma.company.findMany({ select: { id: true, updatedAt: true }, orderBy: { id: "asc" } }),
    ).toEqual(antes.empresas);
  });

  it("não imprime a senha de demonstração em lugar nenhum", () => {
    const fonte = readFileSync(SEED, "utf8");
    // Toda chamada de console que mencione a constante da senha.
    expect(fonte).not.toMatch(/console\.[a-z]+\([^;]*DEMO_PASSWORD/);
    const senha = /const DEMO_PASSWORD = "([^"]+)"/.exec(fonte)?.[1];
    expect(senha).toBeTruthy();
    for (const linha of fonte.split("\n").filter((l) => /console\./.test(l))) {
      expect(linha).not.toContain(senha!);
    }
  });
});
