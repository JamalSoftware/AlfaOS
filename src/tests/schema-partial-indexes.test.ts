import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * RC-DB-02 — os índices únicos PARCIAIS não podem sumir em silêncio.
 *
 * Os três abaixo existem só no SQL das migrations: o DSL do Prisma não expressa
 * `WHERE`, então `schema.prisma` não sabe deles. Uma migration GERADA no futuro
 * (`prisma migrate dev`) pode concluir que eles "sobram" e escrever um
 * `DROP INDEX` — e nada no schema acusaria. Cada um é a última barreira de uma
 * invariante que a aplicação também defende, mas não sozinha:
 *
 * - um template de checklist padrão por empresa;
 * - no máximo um cliente ATIVO por porta de CTO;
 * - no máximo uma porta ATIVA por cliente.
 *
 * O guard confere o banco de verdade (o de teste recebe `migrate deploy` no
 * `globalSetup`) e o histórico de migrations, e prova que falha quando o índice
 * some ou muda de definição.
 */

interface IndiceEsperado {
  nome: string;
  tabela: string;
  colunas: string[];
  predicado: RegExp;
  migration: string;
}

const CRITICOS: IndiceEsperado[] = [
  {
    nome: "checklist_templates_company_default_key",
    tabela: "checklist_templates",
    colunas: ["companyId"],
    predicado: /"serviceOrderTypeId" IS NULL/,
    migration: "20260827180000_add_field_execution_and_closing",
  },
  {
    nome: "customer_network_connections_active_port_key",
    tabela: "customer_network_connections",
    colunas: ["ctoPortId"],
    predicado: /"disconnectedAt" IS NULL/,
    migration: "20260907214839_add_customer_network_connections",
  },
  {
    nome: "customer_network_connections_active_customer_key",
    tabela: "customer_network_connections",
    colunas: ["customerId"],
    predicado: /"disconnectedAt" IS NULL/,
    migration: "20260907214839_add_customer_network_connections",
  },
];

type Cliente = Pick<Prisma.TransactionClient, "$queryRaw">;

interface IndiceNoBanco {
  tabela: string;
  unico: boolean;
  predicado: string | null;
  colunas: string[];
}

async function lerIndice(cliente: Cliente, nome: string): Promise<IndiceNoBanco | null> {
  const linhas = await cliente.$queryRaw<IndiceNoBanco[]>`
    SELECT t.relname::text AS tabela,
           ix.indisunique AS unico,
           pg_get_expr(ix.indpred, ix.indrelid) AS predicado,
           ARRAY(
             SELECT a.attname::text
               FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ordem)
               JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
              ORDER BY k.ordem
           ) AS colunas
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE i.relname = ${nome}
       AND n.nspname = current_schema()`;
  return linhas[0] ?? null;
}

/** O guard: lança nomeando TODO índice ausente ou divergente. */
async function exigirIndicesParciais(cliente: Cliente): Promise<void> {
  const problemas: string[] = [];
  for (const esperado of CRITICOS) {
    const real = await lerIndice(cliente, esperado.nome);
    if (!real) {
      problemas.push(`${esperado.nome}: ausente`);
      continue;
    }
    if (real.tabela !== esperado.tabela) problemas.push(`${esperado.nome}: tabela ${real.tabela}`);
    if (!real.unico) problemas.push(`${esperado.nome}: deixou de ser UNIQUE`);
    if (JSON.stringify(real.colunas) !== JSON.stringify(esperado.colunas)) {
      problemas.push(`${esperado.nome}: colunas ${real.colunas.join(",")}`);
    }
    if (!real.predicado || !esperado.predicado.test(real.predicado)) {
      problemas.push(`${esperado.nome}: predicado ${real.predicado ?? "(nenhum — virou índice total)"}`);
    }
  }
  if (problemas.length > 0) {
    throw new Error(`Índices parciais críticos divergentes:\n${problemas.join("\n")}`);
  }
}

class Desfazer extends Error {}

/** Roda `sabotar` numa transação que SEMPRE volta, e devolve o erro do guard. */
async function guardSob(sabotar: (tx: Prisma.TransactionClient) => Promise<void>): Promise<unknown> {
  let doGuard: unknown = null;
  await prisma
    .$transaction(async (tx) => {
      await sabotar(tx);
      try {
        await exigirIndicesParciais(tx);
      } catch (e) {
        doGuard = e;
      }
      throw new Desfazer();
    })
    .catch((e) => {
      if (!(e instanceof Desfazer)) throw e;
    });
  return doGuard;
}

describe("RC-DB-02 — índices únicos parciais", () => {
  it("os três existem no banco, únicos, nas colunas e com o predicado certos", async () => {
    await expect(exigirIndicesParciais(prisma)).resolves.toBeUndefined();
  });

  it("cada um nasce na sua migration e nenhuma migration posterior o derruba", () => {
    const pasta = path.resolve(__dirname, "../../prisma/migrations");
    const migrations = readdirSync(pasta, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();

    for (const esperado of CRITICOS) {
      const sqlDeOrigem = readFileSync(path.join(pasta, esperado.migration, "migration.sql"), "utf8");
      expect(sqlDeOrigem, `${esperado.nome} não é criado em ${esperado.migration}`).toMatch(
        new RegExp(`CREATE UNIQUE INDEX "${esperado.nome}"[\\s\\S]*?WHERE`),
      );
      for (const nome of migrations) {
        const sql = readFileSync(path.join(pasta, nome, "migration.sql"), "utf8");
        expect(sql, `${nome} derruba ${esperado.nome}`).not.toMatch(
          new RegExp(`DROP INDEX[^;]*"${esperado.nome}"`),
        );
      }
    }
  });

  it("sabotagem: índice REMOVIDO — o guard falha", async () => {
    const erro = await guardSob(async (tx) => {
      await tx.$executeRawUnsafe(`DROP INDEX "customer_network_connections_active_port_key"`);
    });
    expect(String(erro)).toMatch(/customer_network_connections_active_port_key: ausente/);
  });

  it("sabotagem: vira índice TOTAL (sem WHERE) — o guard falha", async () => {
    const erro = await guardSob(async (tx) => {
      await tx.$executeRawUnsafe(`DROP INDEX "checklist_templates_company_default_key"`);
      await tx.$executeRawUnsafe(
        `CREATE INDEX "checklist_templates_company_default_key" ON "checklist_templates"("companyId")`,
      );
    });
    expect(String(erro)).toMatch(/checklist_templates_company_default_key: deixou de ser UNIQUE/);
    expect(String(erro)).toMatch(/virou índice total/);
  });

  it("sabotagem: coluna trocada — o guard falha", async () => {
    const erro = await guardSob(async (tx) => {
      await tx.$executeRawUnsafe(`DROP INDEX "customer_network_connections_active_customer_key"`);
      await tx.$executeRawUnsafe(
        `CREATE UNIQUE INDEX "customer_network_connections_active_customer_key"
           ON "customer_network_connections"("ctoPortId") WHERE "disconnectedAt" IS NULL AND "customerId" IS NOT NULL`,
      );
    });
    expect(String(erro)).toMatch(/customer_network_connections_active_customer_key: colunas ctoPortId/);
  });

  it("depois das sabotagens, o banco continua íntegro (as transações voltaram)", async () => {
    await expect(exigirIndicesParciais(prisma)).resolves.toBeUndefined();
  });
});
