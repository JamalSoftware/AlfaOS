import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCompanyDate, formatCompanyDateTime, formatCompanyTime } from "@/lib/company-datetime";

/**
 * # `RC-1` — nenhuma tela formata data no relógio do servidor (débito §12)
 *
 * O defeito não aparece em desenvolvimento: a máquina do desenvolvedor e a
 * empresa costumam estar no mesmo fuso, e `Intl.DateTimeFormat` sem `timeZone`
 * acerta por coincidência. Em produção o processo roda em UTC, e a mesma tela
 * que decide "Hoje" por `Company.timezone` escrevia a data do servidor ao lado.
 *
 * A fronteira é `src/lib/company-datetime.ts`: ele é o único lugar que constrói
 * um formatador de data, e ele exige o fuso. Uma tela que crie o seu volta a
 * poder esquecer o `timeZone`, e ninguém perceberia até a operação reclamar de
 * um horário errado.
 */

const RAIZ = process.cwd();

function arquivosDeTela(dir: string, acc: string[] = []): string[] {
  for (const item of readdirSync(path.join(RAIZ, dir), { withFileTypes: true })) {
    const relativo = `${dir}/${item.name}`;
    if (item.isDirectory()) arquivosDeTela(relativo, acc);
    else if (item.name.endsWith(".tsx") || item.name.endsWith(".ts")) acc.push(relativo);
  }
  return acc;
}

describe("RC-TZ — o fuso da empresa é a autoridade da tela", () => {
  it("RC-TZ-UNIT-01 · nenhuma tela formata data sem dizer o fuso", () => {
    /*
      A tela PODE construir um formatador — as de jornada o fazem, com o fuso do
      próprio dia —; o que ela não pode é OMITIR o fuso, porque aí o `Intl` cai
      no do processo. A conferência é por CHAMADA, não por arquivo: um arquivo
      com duas chamadas pode acertar uma e esquecer a outra.
    */
    const infratores: string[] = [];
    for (const relativo of arquivosDeTela("src/app")) {
      const codigo = readFileSync(path.join(RAIZ, relativo), "utf8");
      let indice = codigo.indexOf("new Intl.DateTimeFormat");
      while (indice >= 0) {
        const fim = codigo.indexOf("})", indice);
        const chamada = codigo.slice(indice, fim < 0 ? codigo.length : fim);
        if (!chamada.includes("timeZone")) infratores.push(relativo);
        indice = codigo.indexOf("new Intl.DateTimeFormat", indice + 1);
      }
    }
    expect(infratores).toEqual([]);
  });

  it("RC-TZ-UNIT-02 · o formatador central exige o fuso e o respeita", () => {
    // 2026-03-10T23:30:00Z é dia 10 em São Paulo e dia 11 em Tóquio.
    const instante = new Date("2026-03-10T23:30:00Z");
    expect(formatCompanyDateTime(instante, "America/Sao_Paulo")).toBe("10/03/2026, 20:30");
    expect(formatCompanyDateTime(instante, "Asia/Tokyo")).toBe("11/03/2026, 08:30");
    expect(formatCompanyDate(instante, "America/Sao_Paulo")).toBe("10/03/2026");
    expect(formatCompanyDate(instante, "Asia/Tokyo")).toBe("11/03/2026");
    expect(formatCompanyTime(instante, "America/Sao_Paulo")).toBe("20:30");
    expect(formatCompanyTime(instante, "Asia/Tokyo")).toBe("08:30");
  });

  it("RC-TZ-UNIT-03 · a leitura do fuso tem um dono só", () => {
    /*
      `companySliceClock` (recortes do painel) e as telas que só formatam data
      precisam da MESMA resposta. Duas leituras seriam duas respostas possíveis
      para uma empresa sem fuso configurado.
    */
    const slices = readFileSync(path.join(RAIZ, "src/lib/service-order-slices.ts"), "utf8");
    expect(slices).toMatch(/companyTimezone\(companyId\)/);
    expect(slices).not.toMatch(/resolveTimezone\(/);

    /*
      Nenhuma TELA lê a coluna por conta própria: quem precisa do fuso pede a
      `companyTimezone`. Os módulos de domínio que leem `Company.timezone` com
      pergunta própria (jornada, pacote de evidências) continuam como estão —
      eles não formatam a data desta tela, e uni-los seria mudança de contrato,
      não pagamento de débito.
    */
    const telasQueLeem = arquivosDeTela("src/app").filter((relativo) =>
      /select:\s*\{\s*timezone:\s*true\s*\}/.test(readFileSync(path.join(RAIZ, relativo), "utf8")),
    );
    expect(telasQueLeem).toEqual([]);
  });
});
