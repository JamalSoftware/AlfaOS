import { describe, expect, it } from "vitest";

import { customerFirstName } from "@/lib/customer-presentation";

describe("customerFirstName — o rótulo do cliente no mapa", () => {
  it("FIRSTNAME-01 · Maria Gonçalves vira Maria", () => {
    expect(customerFirstName("Maria Gonçalves")).toBe("Maria");
  });

  it("FIRSTNAME-02 · caixa alta vira caixa de apresentação", () => {
    /*
      O cadastro é escrito de jeitos diferentes por gente diferente, e o mapa
      não pode gritar por causa disso. A acentuação fica: ela é do nome.
    */
    expect(customerFirstName("ROSELI JESUNO DE SOUZA TEIXEIRA")).toBe("Roseli");
    expect(customerFirstName("maria gonçalves")).toBe("Maria");
    expect(customerFirstName("ÂNGELA SOUZA")).toBe("Ângela");
  });

  it("FIRSTNAME-03 · João da Silva Neto vira João", () => {
    expect(customerFirstName("João da Silva Neto")).toBe("João");
  });

  it("FIRSTNAME-04 · um nome só devolve ele mesmo", () => {
    expect(customerFirstName("Carlos")).toBe("Carlos");
  });

  it("FIRSTNAME-05 · espaços sobrando não quebram", () => {
    expect(customerFirstName("   Ana    Maria   ")).toBe("Ana");
    expect(customerFirstName("\tJoão\nTeixeira  ")).toBe("João");
  });

  it("FIRSTNAME-06 · NUNCA devolve o nome completo", () => {
    /*
      É a regra de privacidade do rótulo, e ela é afirmada como propriedade:
      seja qual for o nome, o que volta não tem espaço no meio.
    */
    for (const nome of [
      "Maria Gonçalves",
      "Roseli Jesuno de Souza Teixeira",
      "João da Silva Neto",
      "Ana Maria Braga dos Santos",
    ]) {
      const saida = customerFirstName(nome);
      expect(saida).not.toBe(nome);
      expect(saida, `sobrou mais de uma palavra: ${saida}`).not.toMatch(/\s/);
      expect(nome.toLocaleLowerCase()).toContain(saida.toLocaleLowerCase());
    }
  });

  it("FIRSTNAME-07 · partícula no começo não vira o rótulo", () => {
    // "de Souza" tem "Souza" como primeiro nome de fato.
    expect(customerFirstName("de Souza")).toBe("Souza");
    expect(customerFirstName("dos Santos Silva")).toBe("Santos");
  });

  it("FIRSTNAME-08 · sem nome, sem rótulo — e nada é fabricado", () => {
    expect(customerFirstName("")).toBe("");
    expect(customerFirstName("    ")).toBe("");
  });

  it("FIRSTNAME-09 · só conectores ainda devolve a primeira palavra", () => {
    expect(customerFirstName("de")).toBe("De");
  });

  it("FIRSTNAME-10 · nome composto por hífen é um nome só, com as duas iniciais", () => {
    expect(customerFirstName("ANA-CLARA DE SOUZA")).toBe("Ana-Clara");
    expect(customerFirstName("josé-maria silva")).toBe("José-Maria");
  });
});
