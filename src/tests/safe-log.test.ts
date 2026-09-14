import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { logServerError, summarizeError } from "@/lib/safe-log";
import { runApi } from "@/lib/api";
import { runFieldApi } from "@/lib/field/response";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";

/**
 * RC-LOG-01 — log de erro de servidor não carrega dado.
 *
 * Mensagem de erro é texto livre de quem lançou: o Prisma põe nela os
 * ARGUMENTOS da consulta (nome, documento, `details` de auditoria), o
 * filesystem põe o caminho absoluto com a chave de storage, e qualquer `throw
 * new Error(\`...${valor}\`)` põe o valor. Nada disso pode ir para log de
 * produção, que costuma sair da máquina.
 *
 * O contrato: tipo do erro + código seguro (Prisma `P####`, errno `E*`) +
 * contexto que o CHAMADOR escolheu (ids, códigos). Nunca a mensagem.
 */

const CPF = "123.456.789-09";
const SENHA = "senha=hunter2-segredo";
const TOKEN = "Bearer eyJhbGciOiJIUzI1NiJ9.segredo";
const CAMINHO = "C:\\Projetos\\alfaos\\.storage\\cmp1\\ord1\\foto-cliente.jpg";
const PPPOE = "pppoe-cliente-4321";

const SENSIVEIS = [CPF, "hunter2", "eyJhbGciOiJIUzI1NiJ9", CAMINHO, "foto-cliente", PPPOE];

function capturar() {
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  return {
    texto: () =>
      spy.mock.calls
        .flat()
        .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
        .join("\n"),
    spy,
  };
}

function semSensivel(texto: string) {
  for (const s of SENSIVEIS) {
    expect(texto, `o log vazou: ${s}`).not.toContain(s);
  }
}

function erroVenenoso(): Error {
  const erro = new Error(
    `Falhou para o cliente CPF ${CPF}, ${SENHA}, ${TOKEN}, arquivo ${CAMINHO}, PPPoE ${PPPOE}`,
  );
  erro.name = "ErroDeTeste";
  return erro;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("summarizeError", () => {
  it("guarda o tipo e o código seguro, nunca a mensagem", () => {
    const e = Object.assign(erroVenenoso(), { code: "P2002" });
    expect(summarizeError(e)).toEqual({ erro: "ErroDeTeste", codigo: "P2002" });
  });

  it("código que não é Prisma nem errno é descartado (pode ser texto livre)", () => {
    const e = Object.assign(new Error("x"), { code: `valor ${CPF}` });
    expect(summarizeError(e)).toEqual({ erro: "Error" });
  });

  it("nome forjado com dado vira um nome genérico", () => {
    const e = new Error("x");
    e.name = `Cliente ${CPF}`;
    expect(summarizeError(e)).toEqual({ erro: "Error" });
  });

  it("throw de valor que não é Error não é impresso", () => {
    expect(summarizeError(`texto ${CPF}`)).toEqual({ erro: "desconhecido" });
    expect(summarizeError({ cpf: CPF })).toEqual({ erro: "desconhecido" });
  });
});

describe("logServerError", () => {
  it("erro com CPF, senha, token e caminho: nada disso sai no log", () => {
    const log = capturar();
    logServerError("teste", erroVenenoso(), { operacao: "salvar", companyId: "cmp_123" });
    const texto = log.texto();
    semSensivel(texto);
    expect(texto).toContain("[teste]");
    expect(texto).toContain("operacao=salvar");
    expect(texto).toContain("companyId=cmp_123");
    expect(texto).toContain("erro=ErroDeTeste");
  });

  it("contexto com texto livre é recusado pelo formato, não confiado ao chamador", () => {
    const log = capturar();
    logServerError("teste", new Error("x"), { nome: `Fulano ${CPF}` });
    semSensivel(log.texto());
    expect(log.texto()).toContain("nome=?");
  });

  it("erro REAL de validação do Prisma, com o CPF nos argumentos, não vaza", async () => {
    let erro: unknown;
    try {
      await prisma.customer.findFirst({
        // Campo inexistente: o Prisma lança PrismaClientValidationError com os
        // argumentos inteiros — inclusive o documento — na mensagem.
        where: { document: CPF, campoQueNaoExiste: 1 } as never,
      });
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(Prisma.PrismaClientValidationError);
    expect((erro as Error).message).toContain(CPF); // pré-condição: a mensagem TEM o dado

    const log = capturar();
    logServerError("teste", erro);
    semSensivel(log.texto());
    expect(log.texto()).toContain("erro=PrismaClientValidationError");
  });

  it("erro REAL de filesystem: errno sai, caminho não", async () => {
    let erro: unknown;
    try {
      await fs.readFile(path.join(CAMINHO, "nao-existe.jpg"));
    } catch (e) {
      erro = e;
    }
    expect((erro as Error).message).toContain("foto-cliente"); // pré-condição

    const log = capturar();
    logServerError("teste", erro);
    semSensivel(log.texto());
    expect(log.texto()).toMatch(/codigo=E[A-Z]+/);
  });

  it("em desenvolvimento, a pilha ajuda — e continua sem a mensagem", () => {
    vi.stubEnv("NODE_ENV", "development");
    const log = capturar();
    logServerError("teste", erroVenenoso());
    const texto = log.texto();
    semSensivel(texto);
    expect(texto).toMatch(/\bat\b .*safe-log\.test\.ts:\d+:\d+/);
  });

  it("em produção, nem a pilha", () => {
    vi.stubEnv("NODE_ENV", "production");
    const log = capturar();
    logServerError("teste", erroVenenoso());
    const texto = log.texto();
    semSensivel(texto);
    expect(texto).not.toMatch(/\bat\b .*:\d+:\d+/);
  });
});

describe("o log do próprio Prisma", () => {
  it("fora de desenvolvimento, erro do banco com valor na mensagem não é impresso pelo Prisma", async () => {
    const saidas = [
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
    ];
    let erro: unknown;
    try {
      // O Postgres põe o VALOR na mensagem: invalid input syntax for type
      // integer: "123.456.789-09". O erro chega ao chamador de qualquer jeito.
      await prisma.$queryRawUnsafe("SELECT $1::int AS n", CPF);
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(Error);
    expect(String((erro as Error).message)).toContain(CPF); // pré-condição

    const impresso = saidas
      .flatMap((s) => s.mock.calls.flat())
      .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
      .join("\n");
    expect(impresso).not.toContain(CPF);
  });
});

describe("os pontos que imprimiam o erro cru", () => {
  it("runApi: 500 genérico, e o log sem o conteúdo da mensagem", async () => {
    const log = capturar();
    const res = await runApi(async () => {
      throw erroVenenoso();
    });
    expect(res.status).toBe(500);
    const corpo = await res.text();
    semSensivel(corpo);
    semSensivel(log.texto());
    expect(log.texto()).toContain("[api:error]");
  });

  it("runFieldApi: INTERNAL genérico, e o log sem o conteúdo da mensagem", async () => {
    const log = capturar();
    const res = await runFieldApi(async () => {
      throw erroVenenoso();
    });
    expect(res.status).toBe(500);
    semSensivel(await res.text());
    semSensivel(log.texto());
    expect(log.texto()).toContain("[field:error]");
  });

  it("logAudit: a falha ao gravar não imprime o `details` que ia ser gravado", async () => {
    const log = capturar();
    // companyId inexistente: a FK recusa, e o erro do Prisma carregaria os
    // argumentos — inclusive o `details`, com nome e documento de cliente.
    await logAudit({
      companyId: "empresa-que-nao-existe",
      userId: null,
      action: "CUSTOMER.UPDATED",
      entity: "Customer",
      entityId: "c1",
      details: `Cliente Fulano CPF ${CPF}`,
    });
    const texto = log.texto();
    expect(texto).toContain("[audit]");
    expect(texto).toContain("acao=CUSTOMER.UPDATED");
    semSensivel(texto);
  });
});
