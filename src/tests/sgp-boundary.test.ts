import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * # A fronteira do adapter, cobrada sobre o FONTE
 *
 * A regra "adapter e client não tocam banco nem cofre de credenciais" é o que
 * mantém `resolveCompanyAdapter` como o único ponto que decifra um segredo.
 * Ela é respeitada por disciplina, e um `import` distraído a quebraria **sem
 * produzir sintoma**: os testes de comportamento continuariam verdes e a
 * superfície de segredo teria dobrado em silêncio.
 *
 * Nenhum teste de comportamento pega isso. Um teste sobre o texto do fonte pega.
 */

function arquivosDe(dir: string): string[] {
  const saida: string[] = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) saida.push(...arquivosDe(caminho));
    else if (nome.endsWith(".ts")) saida.push(caminho);
  }
  return saida;
}

const PROIBIDOS = [
  "@/lib/prisma",
  "./prisma",
  "../prisma",
  "../../lib/prisma",
  "erp-credential-cipher",
  "erp-credential-store",
  "erp-credentials",
  "erp-provisioning",
  "erp-integration",
];

describe("Fronteira de src/integrations", () => {
  it("nenhum adapter ou client importa Prisma nem o cofre de credenciais", () => {
    const ofensores: string[] = [];

    for (const arquivo of arquivosDe(join(process.cwd(), "src", "integrations"))) {
      for (const linha of readFileSync(arquivo, "utf8").split(/\r?\n/)) {
        const imp = /^\s*import\s.*from\s+["']([^"']+)["']/.exec(linha);
        if (!imp) continue;

        /**
         * `import type` de `@prisma/client` é permitido: tipo não carrega
         * runtime, não abre conexão e não alcança segredo. O que a regra proíbe
         * é o CLIENTE, não o vocabulário do schema.
         */
        if (/^\s*import\s+type\s/.test(linha)) continue;

        const alvo = imp[1];
        if (alvo === "@prisma/client") {
          ofensores.push(`${arquivo.replace(process.cwd(), "")}: ${alvo}`);
          continue;
        }
        if (PROIBIDOS.some((p) => alvo === p || alvo.includes(p))) {
          ofensores.push(`${arquivo.replace(process.cwd(), "")}: ${alvo}`);
        }
      }
    }

    expect(ofensores).toEqual([]);
  });

  it("nenhum adapter lê variável de ambiente de credencial", () => {
    const ofensores: string[] = [];
    for (const arquivo of arquivosDe(join(process.cwd(), "src", "integrations"))) {
      const fonte = readFileSync(arquivo, "utf8");
      if (/ERP_CREDENTIAL_ENCRYPTION_KEY|process\.env\.[A-Z_]*TOKEN/.test(fonte)) {
        ofensores.push(arquivo.replace(process.cwd(), ""));
      }
    }
    expect(ofensores).toEqual([]);
  });

  it("o cliente do SGP não imprime nada — token nunca vai a log", () => {
    const fonte = readFileSync(
      join(process.cwd(), "src", "integrations", "sgp", "SgpClient.ts"),
      "utf8",
    );
    /**
     * O token viaja no CORPO da requisição do SGP. Um `console.log` do body,
     * mesmo em depuração, o despejaria em arquivo, agregador e ticket de
     * suporte.
     */
    expect(fonte).not.toMatch(/console\.(log|info|warn|error|debug)/);
  });

  it("o SgpAdapter não declara capability de negócio no fonte", () => {
    /**
     * Comentários são removidos antes da checagem.
     *
     * O arquivo EXPLICA por que não declara capability, e essa explicação
     * precisa nomear as interfaces. Sem tirar os comentários, o teste passaria
     * a proibir a documentação da própria decisão — e o jeito de fazê-lo passar
     * seria apagar o texto que diz por quê.
     */
    const fonte = readFileSync(
      join(process.cwd(), "src", "integrations", "SgpAdapter.ts"),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/.*$/gm, " ");
    /**
     * Complementa o teste estrutural de `sgp-provider.test.ts`: aqui a
     * afirmação é sobre a DECLARAÇÃO. Um `implements ERPCustomerLookupCapability`
     * com métodos ainda ausentes não compilaria — mas um método vazio
     * adicionado às pressas compilaria, e este teste é o que obriga a fase certa
     * a ser aberta.
     */
    for (const proibido of [
      "ERPCustomerLookupCapability",
      "ERPDiagnosticsCapability",
      "ERPServiceTicketsCapability",
      "searchCustomers",
      "getCustomerDetail",
      "fetchCustomerConnectivity",
      "listOpenTickets",
      "listServiceOrders",
    ]) {
      expect(fonte).not.toContain(proibido);
    }
  });
});
