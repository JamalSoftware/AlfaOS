import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { LocalFileStorageAdapter, setFileStorage, type FileStorageContract } from "@/lib/storage";
import {
  auditPhotoStorage,
  ORPHAN_GRACE_MS,
  OrphanPurgeScopeError,
  purgeOrphanFiles,
} from "@/lib/storage/photo-audit";
import { seedTestData, type TestFixture } from "./helpers";
import { montarJpegSimples } from "./support/jpeg-exif";

/**
 * # RC-1E · o expurgo de órfãos exige escopo explícito
 *
 * A auditoria do banco de desenvolvimento achou dois grupos de candidatos que
 * não são a mesma decisão: resíduo de empresas de teste que não existem mais e
 * fotos antigas de uma CTO de empresa que continua operando. O `--apply` antigo
 * apagava os dois juntos, e "não execute" escrito em documentação não protege
 * um comando destrutivo.
 *
 * O contrato agora é da FUNÇÃO, e o comando só o repassa:
 *
 * - simular não precisa de escopo;
 * - aplicar sem escopo é recusado antes de qualquer leitura;
 * - `missing-company` é o único escopo que apaga;
 * - `active-company` só simula; aplicado, é recusado;
 * - não existe "todos".
 *
 * Tudo aqui roda num storage TEMPORÁRIO. Nenhum teste toca o `.storage` real.
 */

let fixture: TestFixture;
let raiz: string;
let storage: FileStorageContract;

const RAIZ_DO_PROJETO = path.resolve(__dirname, "../..");
const TSX = path.join(RAIZ_DO_PROJETO, "node_modules", "tsx", "dist", "cli.mjs");
const SCRIPT = path.join(RAIZ_DO_PROJETO, "scripts", "photo-storage-audit.ts");

const DIA = 24 * 60 * 60 * 1000;
const EMPRESA_INEXISTENTE = "empresaapagadaescopo0000000";
const depoisDaCarencia = () => new Date(Date.now() + ORPHAN_GRACE_MS + DIA);
const chave = (empresa: string, escopo = "sobra") =>
  `${empresa}/${escopo}/${randomUUID().replace(/-/g, "")}.jpg`;

beforeAll(async () => {
  raiz = await fs.mkdtemp(path.join(os.tmpdir(), "alfaos-expurgo-escopo-"));
});
afterAll(async () => {
  setFileStorage(null);
  await fs.rm(raiz, { recursive: true, force: true });
});
beforeEach(async () => {
  await fs.rm(raiz, { recursive: true, force: true });
  await fs.mkdir(raiz, { recursive: true });
  storage = new LocalFileStorageAdapter(raiz);
  setFileStorage(storage);
  fixture = await seedTestData();
});

async function gravar(k: string, { velho = true } = {}) {
  const cheio = path.join(raiz, k);
  await fs.mkdir(path.dirname(cheio), { recursive: true });
  await fs.writeFile(cheio, montarJpegSimples());
  if (velho) {
    const antigo = new Date(Date.now() - 3 * DIA);
    await fs.utimes(cheio, antigo, antigo);
  }
  return k;
}

/** Os dois grupos, mais um arquivo em uso — o cenário do banco de desenvolvimento. */
async function cenario() {
  const residuo = [await gravar(chave(EMPRESA_INEXISTENTE)), await gravar(chave(EMPRESA_INEXISTENTE))];
  const historica = await gravar(chave(fixture.companyA.id, "fotoantigacto"));
  const emUso = await gravar(chave(fixture.companyA.id, "emuso"));
  await prisma.cTO.create({
    data: { companyId: fixture.companyA.id, name: "CTO em uso", capacity: 2, photoStorageKey: emUso },
  });
  return { residuo, historica, emUso };
}

async function hashes(): Promise<Record<string, string>> {
  const saida: Record<string, string> = {};
  for await (const e of new LocalFileStorageAdapter(raiz).list()) {
    saida[e.key] = createHash("sha256")
      .update(await fs.readFile(path.join(raiz, e.key)))
      .digest("hex");
  }
  return saida;
}

function comando(...args: string[]) {
  return spawnSync(process.execPath, [TSX, SCRIPT, ...args], {
    cwd: RAIZ_DO_PROJETO,
    env: { ...process.env, STORAGE_ROOT: raiz },
    encoding: "utf8",
    timeout: 90_000,
  });
}

describe("PURGE-SCOPE-01 · aplicar sem escopo é recusado, e nada é apagado", () => {
  it("a função lança antes de qualquer leitura", async () => {
    await cenario();
    const antes = await hashes();

    await expect(purgeOrphanFiles({ storage, apply: true, now: depoisDaCarencia() })).rejects.toBeInstanceOf(
      OrphanPurgeScopeError,
    );
    await expect(purgeOrphanFiles({ storage, apply: true, now: depoisDaCarencia() })).rejects.toThrow(
      /exige --scope missing-company/,
    );
    expect(await hashes()).toEqual(antes);
  });

  it("o comando de linha sai com erro e não apaga nenhum arquivo", async () => {
    await cenario();
    const antes = await hashes();

    const r = comando("--purge-orphans", "--apply");

    expect(r.status).not.toBe(0);
    expect(`${r.stderr}${r.stdout}`).toMatch(/RECUSADO: .*exige --scope missing-company/);
    expect(r.stdout).not.toMatch(/APLICADO/);
    expect(await hashes()).toEqual(antes);
  });
});

describe("PURGE-SCOPE-02 · simular continua amplo e sem escopo", () => {
  it("a simulação mostra os dois grupos e não apaga nada — pela função e pelo comando", async () => {
    const c = await cenario();
    const antes = await hashes();

    const relatorio = await auditPhotoStorage({ storage });
    expect(relatorio.orphansOfMissingCompanies).toBe(2);
    expect(relatorio.orphansOfExistingCompanies).toBe(1);
    expect(relatorio.missingCompanyOrphans.sort()).toEqual([...c.residuo].sort());
    expect(relatorio.activeCompanyOrphans).toEqual([c.historica]);

    const simulado = await purgeOrphanFiles({ storage, apply: false });
    expect(simulado).toMatchObject({ scope: null, candidates: 3, deleted: 0 });

    const r = comando("--purge-orphans");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/SIMULADO — nada foi apagado .*candidatos=3 apagados=0/);

    const auditoria = comando();
    expect(auditoria.status).toBe(0);
    expect(auditoria.stdout).toMatch(/de-empresa-inexistente=2 de-empresa-existente=1/);

    expect(await hashes()).toEqual(antes);
  });
});

describe("PURGE-SCOPE-03/04 · missing-company apaga só o resíduo", () => {
  it("apaga o de empresa inexistente; o de empresa existente e o em uso ficam", async () => {
    const c = await cenario();

    const r = await purgeOrphanFiles({ storage, apply: true, scope: "missing-company", now: depoisDaCarencia() });

    expect(r).toMatchObject({ scope: "missing-company", candidates: 2, deleted: 2, relinked: 0, failed: 0 });
    for (const k of c.residuo) expect(existsSync(path.join(raiz, k)), k).toBe(false);
    expect(existsSync(path.join(raiz, c.historica))).toBe(true);
    expect(existsSync(path.join(raiz, c.emUso))).toBe(true);
  });

  it("pelo comando de linha, com o escopo, o mesmo resultado", async () => {
    const c = await cenario();

    const r = comando("--purge-orphans", "--apply", "--scope", "missing-company");

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/APLICADO escopo=missing-company: candidatos=2 apagados=2/);
    expect(existsSync(path.join(raiz, c.historica))).toBe(true);
    expect(existsSync(path.join(raiz, c.emUso))).toBe(true);
  });
});

describe("PURGE-SCOPE-05 · active-company e qualquer 'todos' são recusados", () => {
  it("active-company aplicado é recusado por falta de decisão do dono — nada é apagado", async () => {
    await cenario();
    const antes = await hashes();

    await expect(
      purgeOrphanFiles({ storage, apply: true, scope: "active-company", now: depoisDaCarencia() }),
    ).rejects.toThrow(/active-company orphan purge requires owner decision/);

    const r = comando("--purge-orphans", "--apply", "--scope", "active-company");
    expect(r.status).not.toBe(0);
    expect(`${r.stderr}${r.stdout}`).toMatch(/requires owner decision/);

    expect(await hashes()).toEqual(antes);
  });

  it("active-company SIMULADO é permitido: mostra o grupo, não apaga", async () => {
    const c = await cenario();
    const r = await purgeOrphanFiles({ storage, apply: false, scope: "active-company" });
    expect(r).toMatchObject({ scope: "active-company", candidates: 1, deleted: 0 });
    expect(existsSync(path.join(raiz, c.historica))).toBe(true);
  });

  it("não existe escopo 'todos': all, --all e escopo vazio são recusados", async () => {
    await cenario();
    const antes = await hashes();

    for (const escopo of ["all", "todos", "", "missing-company,active-company"]) {
      await expect(
        purgeOrphanFiles({ storage, apply: true, scope: escopo, now: depoisDaCarencia() }),
        escopo,
      ).rejects.toBeInstanceOf(OrphanPurgeScopeError);
    }
    const r = comando("--purge-orphans", "--apply", "--all");
    expect(r.status).not.toBe(0);
    const r2 = comando("--purge-orphans", "--apply", "--scope=all");
    expect(r2.status).not.toBe(0);

    expect(await hashes()).toEqual(antes);
  });
});

describe("PURGE-SCOPE-06 · referência que aparece entre a seleção e a exclusão protege o arquivo", () => {
  it("resíduo ligado por uma linha de outra empresa no intervalo: FICA", async () => {
    const k = await gravar(chave(EMPRESA_INEXISTENTE, "religada"));

    const r = await purgeOrphanFiles({
      storage,
      apply: true,
      scope: "missing-company",
      now: depoisDaCarencia(),
      beforeDelete: async (alvo) => {
        await prisma.cTO.create({
          data: { companyId: fixture.companyB.id, name: "CTO religada", capacity: 2, photoStorageKey: alvo },
        });
      },
    });

    expect(r).toMatchObject({ candidates: 1, deleted: 0, relinked: 1 });
    expect(existsSync(path.join(raiz, k))).toBe(true);
  });

  it("referência cross-tenant que JÁ existe: o prefixo diz resíduo, a linha diz em uso — não é candidato", async () => {
    const k = await gravar(chave(EMPRESA_INEXISTENTE, "cruzada"));
    await prisma.cTO.create({
      data: { companyId: fixture.companyB.id, name: "CTO cruzada", capacity: 2, photoStorageKey: k },
    });

    const r = await purgeOrphanFiles({ storage, apply: true, scope: "missing-company", now: depoisDaCarencia() });

    expect(r).toMatchObject({ candidates: 0, deleted: 0 });
    expect(existsSync(path.join(raiz, k))).toBe(true);
  });
});

describe("PURGE-SCOPE-07 · resíduo RECENTE fica", () => {
  it("empresa inexistente não basta: dentro da carência de 24 h, nada é apagado", async () => {
    const recente = await gravar(chave(EMPRESA_INEXISTENTE, "recente"), { velho: false });

    const r = await purgeOrphanFiles({ storage, apply: true, scope: "missing-company" });

    expect(r).toMatchObject({ candidates: 0, deleted: 0 });
    expect(existsSync(path.join(raiz, recente))).toBe(true);
  });
});

describe("PURGE-SCOPE-08 · caminho inválido e link simbólico ficam", () => {
  it("entrada não reconhecida sob prefixo de empresa inexistente não é candidata nem é apagada", async () => {
    const dir = path.join(raiz, EMPRESA_INEXISTENTE, "sobra");
    await fs.mkdir(dir, { recursive: true });
    const estranhos = [
      path.join(dir, "Leia-me.TXT"),
      path.join(dir, `${"b".repeat(32)}.jpg.${randomUUID()}.tmp`),
      path.join(dir, "FOTO.JPG"),
    ];
    for (const f of estranhos) {
      await fs.writeFile(f, "x");
      const antigo = new Date(Date.now() - 3 * DIA);
      await fs.utimes(f, antigo, antigo);
    }

    const r = await purgeOrphanFiles({ storage, apply: true, scope: "missing-company", now: depoisDaCarencia() });

    expect(r).toMatchObject({ candidates: 0, deleted: 0 });
    for (const f of estranhos) expect(existsSync(f), f).toBe(true);
  });

  it("link simbólico com o nome de uma empresa inexistente não é seguido", async (ctx) => {
    const alvo = await fs.mkdtemp(path.join(os.tmpdir(), "alfaos-fora-escopo-"));
    const dentro = path.join(alvo, "sobra");
    await fs.mkdir(dentro, { recursive: true });
    const vitima = path.join(dentro, `${"c".repeat(32)}.jpg`);
    await fs.writeFile(vitima, montarJpegSimples());
    const link = path.join(raiz, EMPRESA_INEXISTENTE);
    try {
      await fs.symlink(alvo, link, "junction");
    } catch {
      ctx.skip();
      return;
    }
    try {
      const r = await purgeOrphanFiles({ storage, apply: true, scope: "missing-company", now: depoisDaCarencia() });
      expect(r.deleted).toBe(0);
      expect(existsSync(vitima)).toBe(true);
    } finally {
      await fs.rm(link, { force: true }).catch(() => undefined);
      await fs.rm(alvo, { recursive: true, force: true });
    }
  });
});
