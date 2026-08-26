import { describe, expect, it } from "vitest";
import {
  coordenadaValida,
  formatarEndereco,
  linksDeNavegacao,
} from "@/lib/map-links";

const ENDERECO = {
  address: "Rua das Palmeiras",
  number: "123",
  complement: "fundos",
  district: "Centro",
  city: "Cachoeiro",
  state: "ES",
  zipCode: "29300-000",
};

describe("coordenada utilizável", () => {
  it("aceita coordenada plausível", () => {
    expect(coordenadaValida(-20.848, -41.113)).toBe(true);
    expect(coordenadaValida(0, -41.113)).toBe(true);
    expect(coordenadaValida(-20.848, 0)).toBe(true);
  });

  /**
   * `(0, 0)` fica no Atlântico, ao sul de Gana, e é o que um cadastro devolve
   * quando o campo nunca foi preenchido. Mandar um técnico para lá é pior do
   * que não oferecer navegação nenhuma — ele sai dirigindo antes de perceber.
   */
  it("recusa (0,0), o vazio disfarçado de coordenada", () => {
    expect(coordenadaValida(0, 0)).toBe(false);
  });

  it("recusa ausente, não-finito e fora de faixa", () => {
    expect(coordenadaValida(null, null)).toBe(false);
    expect(coordenadaValida(-20.8, null)).toBe(false);
    expect(coordenadaValida(null, -41.1)).toBe(false);
    expect(coordenadaValida(undefined, undefined)).toBe(false);
    expect(coordenadaValida(NaN, -41.1)).toBe(false);
    expect(coordenadaValida(Infinity, -41.1)).toBe(false);
    expect(coordenadaValida(-91, -41.1)).toBe(false);
    expect(coordenadaValida(91, -41.1)).toBe(false);
    expect(coordenadaValida(-20.8, -181)).toBe(false);
    expect(coordenadaValida(-20.8, 181)).toBe(false);
  });
});

describe("endereço exibido", () => {
  it("monta na ordem em que se lê um endereço", () => {
    expect(formatarEndereco(ENDERECO)).toBe(
      "Rua das Palmeiras, 123 · fundos · Centro · Cachoeiro/ES · 29300-000",
    );
  });

  /** Campo vazio some. Vírgulas soltas parecem defeito de tela. */
  it("omite o que não existe, sem deixar separador órfão", () => {
    expect(
      formatarEndereco({ address: "Rua A", city: "Vitória", state: "ES" }),
    ).toBe("Rua A · Vitória/ES");
    expect(formatarEndereco({ address: "Rua A" })).toBe("Rua A");
    expect(formatarEndereco({ city: "Vitória" })).toBe("Vitória");
  });

  it("devolve null quando não há endereço nenhum", () => {
    expect(formatarEndereco({})).toBeNull();
    expect(formatarEndereco({ address: "   ", city: "" })).toBeNull();
    expect(formatarEndereco({ address: null, city: null })).toBeNull();
  });
});

describe("links de navegação", () => {
  it("prefere a coordenada quando ela existe", () => {
    const links = linksDeNavegacao({
      ...ENDERECO,
      latitude: -20.848,
      longitude: -41.113,
    });
    expect(links?.origem).toBe("coordenada");
    expect(links?.googleMaps).toContain("google.com/maps");
    expect(links?.googleMaps).toContain("-20.848000%2C-41.113000");
    expect(links?.waze).toContain("waze.com/ul");
    expect(links?.waze).toContain("navigate=yes");
  });

  it("cai para o endereço quando a coordenada não serve", () => {
    for (const coord of [
      { latitude: null, longitude: null },
      { latitude: 0, longitude: 0 },
      { latitude: 999, longitude: 999 },
    ]) {
      const links = linksDeNavegacao({ ...ENDERECO, ...coord });
      expect(links?.origem).toBe("endereco");
      expect(links?.googleMaps).toContain("Rua%20das%20Palmeiras");
    }
  });

  it("sem coordenada e sem endereço, não oferece navegação", () => {
    expect(linksDeNavegacao({})).toBeNull();
    expect(linksDeNavegacao({ latitude: 0, longitude: 0 })).toBeNull();
  });

  /**
   * O endereço é texto digitado por gente. Um `&` num complemento
   * acrescentaria um parâmetro à URL; um `#` cortaria o resto fora; e um
   * `javascript:` num campo de cadastro não pode virar destino.
   */
  it("codifica tudo que vem do cadastro", () => {
    const links = linksDeNavegacao({
      address: "Rua A & B",
      number: "1#2",
      district: "Bairro?x=1",
      city: "São Paulo",
      state: "SP",
    });
    expect(links).not.toBeNull();
    const url = new URL(links!.googleMaps);
    expect(url.origin).toBe("https://www.google.com");
    // Tudo caiu DENTRO do parâmetro, sem criar outros.
    expect(Array.from(url.searchParams.keys()).sort()).toEqual(["api", "query"]);
    expect(url.searchParams.get("query")).toContain("Rua A & B");
    expect(url.searchParams.get("query")).toContain("1#2");

    const waze = new URL(links!.waze);
    expect(waze.origin).toBe("https://waze.com");
    expect(Array.from(waze.searchParams.keys()).sort()).toEqual(["navigate", "q"]);
  });

  it("o destino é sempre um dos dois hosts esperados", () => {
    const comCoord = linksDeNavegacao({
      latitude: -20.848,
      longitude: -41.113,
    })!;
    expect(new URL(comCoord.googleMaps).origin).toBe("https://www.google.com");
    expect(new URL(comCoord.waze).origin).toBe("https://waze.com");
  });

  /**
   * O complemento sai da CONSULTA (atrapalha a geocodificação) mas continua na
   * exibição, onde é o que faz o técnico achar a porta.
   */
  it("o complemento fica fora da busca do mapa e dentro do endereço exibido", () => {
    const links = linksDeNavegacao(ENDERECO)!;
    const query = new URL(links.googleMaps).searchParams.get("query")!;
    expect(query).not.toContain("fundos");
    expect(query).toContain("29300-000");
    expect(formatarEndereco(ENDERECO)).toContain("fundos");
  });
});
