import os from "node:os";
import path from "node:path";

/**
 * A raiz de storage do E2E — a mesma que `playwright.config.ts` entrega ao
 * servidor e aos workers (RC-STO-02).
 *
 * Recusa qualquer raiz que caia no `.storage` do projeto: é o diretório do
 * servidor de desenvolvimento, e é exatamente onde o E2E não pode escrever nem
 * apagar. O `globalSetup` esvazia esta raiz a cada rodada, então apontá-la para
 * o lugar errado apagaria arquivo de verdade.
 */
export function e2eStorageRoot(): string {
  const raiz = path.resolve(
    process.env.STORAGE_ROOT ??
      process.env.E2E_STORAGE_ROOT ??
      path.join(os.tmpdir(), "alfaos-e2e-storage"),
  );
  const doProjeto = path.resolve(__dirname, "..", ".storage");
  if (raiz === doProjeto || raiz.startsWith(doProjeto + path.sep)) {
    throw new Error(
      `STORAGE_ROOT do E2E não pode ser o .storage do projeto (${raiz}): é o do servidor de desenvolvimento.`,
    );
  }
  return raiz;
}
