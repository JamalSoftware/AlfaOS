import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getFileStorage } from "@/lib/storage";

/**
 * RC-STO-02 — teste nenhum escreve no `.storage` de desenvolvimento.
 *
 * Três suítes gravavam etiqueta, foto de CTO e bytes de imagem no storage
 * REAL do projeto, porque não trocavam o adapter; o RC-1A contou 2.027
 * arquivos em 1.867 diretórios de empresas de teste já apagadas. A correção é
 * de INFRAESTRUTURA (`setup.ts`), e não suíte por suíte: toda suíte — as de
 * hoje e as que vierem — nasce com `STORAGE_ROOT` num diretório temporário
 * próprio, apagado no fim do arquivo.
 *
 * Este arquivo não chama `setFileStorage`: ele usa o adapter PADRÃO, que é
 * exatamente o que as suítes culpadas usavam.
 */

const STORAGE_DE_DESENVOLVIMENTO = path.resolve(__dirname, "../..", ".storage");

describe("isolamento do storage nos testes", () => {
  it("STORAGE_ROOT aponta para um diretório temporário, nunca para o .storage do projeto", () => {
    const raiz = process.env.STORAGE_ROOT;
    expect(raiz, "setup.ts deveria ter definido STORAGE_ROOT").toBeTruthy();
    const resolvida = path.resolve(raiz!);
    expect(resolvida.startsWith(path.resolve(os.tmpdir()))).toBe(true);
    expect(resolvida).not.toBe(STORAGE_DE_DESENVOLVIMENTO);
    expect(resolvida.startsWith(STORAGE_DE_DESENVOLVIMENTO)).toBe(false);
  });

  it("o adapter PADRÃO grava no temporário — e nada cai no .storage de desenvolvimento", async () => {
    const empresa = `iso${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const chave = `${empresa}/ordem/arquivo.png`;

    await getFileStorage().put(chave, Buffer.from("isolamento"), "image/png");

    expect(existsSync(path.join(process.env.STORAGE_ROOT!, chave))).toBe(true);
    expect(existsSync(path.join(STORAGE_DE_DESENVOLVIMENTO, empresa))).toBe(false);
  });
});
