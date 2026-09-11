import { describe, expect, it } from "vitest";

import { customerInitials } from "@/lib/customer-initials";

describe("customerInitials — as duas letras do marcador de cliente", () => {
  it("INIT-01 · João Teixeira vira JT", () => {
    expect(customerInitials("João Teixeira")).toBe("JT");
  });

  it("INIT-02 · Maria Aparecida Souza vira MS", () => {
    // Primeira e ÚLTIMA, nunca primeira e segunda: o do meio não identifica.
    expect(customerInitials("Maria Aparecida Souza")).toBe("MS");
  });

  it("INIT-03 · João da Silva Neto vira JN, e não JS", () => {
    /*
      O conector é gramática, não identidade.

      Este é o caso que separa "primeira e última palavra" de "primeira e
      última palavra SIGNIFICATIVA" — sem a lista de conectores o resultado
      ainda seria `JN` aqui, mas "Ana de Souza" viraria `AS` por acidente e
      "Ana de" viraria `AD`.
    */
    expect(customerInitials("João da Silva Neto")).toBe("JN");
  });

  it("INIT-04 · um nome só devolve uma letra", () => {
    expect(customerInitials("Carlos")).toBe("C");
  });

  it("INIT-05 · Ana de Souza vira AS", () => {
    expect(customerInitials("Ana de Souza")).toBe("AS");
  });

  it("INIT-06 · espaço duplicado e sobra nas pontas não quebram", () => {
    expect(customerInitials("  Ana   de   Souza ")).toBe("AS");
    expect(customerInitials("\tJoão\nTeixeira  ")).toBe("JT");
  });

  it("INIT-07 · nunca passa de dois caracteres", () => {
    expect(
      customerInitials("Maria Aparecida da Silva Souza dos Santos Neto"),
    ).toHaveLength(2);
    expect(customerInitials("A B C D E F G")).toHaveLength(2);
  });

  it("INIT-08 · o acento sai, a letra fica", () => {
    // Dezoito pixels não comportam diacrítico: vira sujeira em cima da letra.
    expect(customerInitials("Ângela Éder")).toBe("AE");
    expect(customerInitials("Ñuñez")).toBe("N");
  });

  it("INIT-09 · a saída é SEMPRE [A-Z]{0,2}, e é isso que autoriza o divIcon", () => {
    /*
      O marcador é um `divIcon`, e `divIcon` recebe HTML CRU.

      A regra do projeto é que nome digitado por gente não entra ali. Duas
      letras derivadas podem entrar porque o conjunto de saída não tem um único
      caractere com significado em HTML — e quem garante isso é a peneira final,
      não a boa vontade de quem cadastra.
    */
    const hostis = [
      '<img src=x onerror=alert(1)>',
      "</svg><script>alert(1)</script>",
      "&lt;b&gt; Teste",
      "123 456",
      "🙂 🙃",
      "'; DROP TABLE customers; --",
      "",
      "   ",
    ];
    for (const entrada of hostis) {
      const saida = customerInitials(entrada);
      expect(saida, `entrada: ${entrada}`).toMatch(/^[A-Z]{0,2}$/);
    }
  });

  it("INIT-10 · um nome feito só de conectores ainda devolve letra", () => {
    // Improvável, e não é motivo para devolver vazio havendo letra a mostrar.
    expect(customerInitials("de")).toBe("D");
    expect(customerInitials("da e do")).toBe("DD");
  });
});
