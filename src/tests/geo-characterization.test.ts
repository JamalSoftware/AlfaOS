import { describe, expect, it } from "vitest";
import { DomainError } from "@/lib/errors";
import {
  assertValidAccuracy,
  assertValidCoordinate,
  distanceInMeters,
  MAX_ACCURACY_METERS,
} from "@/lib/geo";
import { coordenadaValida } from "@/lib/map-links";

/**
 * # Caracterização de `src/lib/geo.ts`
 *
 * O módulo existe desde a v0.10 e é usado pela confirmação de localização do
 * cliente e pelo check-in. **Não tinha teste direto** — só cobertura indireta,
 * por `customer-locations`, onde a distância aparece como um número no meio de
 * outra regra.
 *
 * A `CTO-3` vai apoiar a ordenação por proximidade exatamente nestas três
 * funções. Antes de depender delas, este arquivo registra **o que elas fazem
 * hoje**: o modelo esférico com o raio que está no código, e as fronteiras dos
 * dois validadores.
 *
 * É caracterização, não especificação: nada aqui pede mudança de comportamento.
 * Se alguém trocar o modelo — para elipsoidal, por exemplo —, estes testes caem
 * e a troca passa a ser uma decisão visível em vez de um deslocamento silencioso
 * de todas as distâncias do sistema.
 */

/** Raio usado pelo módulo. Um grau de latitude é `2πR/360`. */
const RAIO_M = 6_371_008.8;
const GRAU_DE_LATITUDE_M = (2 * Math.PI * RAIO_M) / 360;

describe("geo · distanceInMeters", () => {
  it("GEO-01 o mesmo ponto tem distância zero", () => {
    const p = { latitude: -20.7746, longitude: -41.6789 };
    expect(distanceInMeters(p, p)).toBe(0);
  });

  it("GEO-02 um grau de latitude vale 2πR/360, no equador e longe dele", () => {
    /*
      A distância por latitude não depende da longitude nem do hemisfério —
      é a propriedade que torna o número derivável do raio em vez de
      memorizado.
    */
    const noEquador = distanceInMeters(
      { latitude: 0, longitude: 0.5 },
      { latitude: 1, longitude: 0.5 },
    );
    const longe = distanceInMeters(
      { latitude: -20, longitude: -41 },
      { latitude: -21, longitude: -41 },
    );
    expect(noEquador).toBe(Math.round(GRAU_DE_LATITUDE_M));
    expect(longe).toBe(Math.round(GRAU_DE_LATITUDE_M));
  });

  it("GEO-03 um grau de longitude encolhe com o cosseno da latitude", () => {
    const em60 = distanceInMeters(
      { latitude: 60, longitude: 0 },
      { latitude: 60, longitude: 1 },
    );
    const esperado = GRAU_DE_LATITUDE_M * Math.cos((60 * Math.PI) / 180);
    // Tolerância de 1 m: a fórmula acumula arredondamento, e o ponto do teste
    // é a RELAÇÃO, não o dígito final.
    expect(Math.abs(em60 - esperado)).toBeLessThanOrEqual(1);
  });

  it("GEO-04 a distância é simétrica", () => {
    const a = { latitude: -20.77, longitude: -41.67 };
    const b = { latitude: -22.9, longitude: -43.17 };
    expect(distanceInMeters(a, b)).toBe(distanceInMeters(b, a));
  });

  it("GEO-05 devolve METROS inteiros, e não fração", () => {
    const d = distanceInMeters(
      { latitude: -20.7746, longitude: -41.6789 },
      { latitude: -20.7756, longitude: -41.6799 },
    );
    expect(Number.isInteger(d)).toBe(true);
    // Um décimo de milésimo de grau nos dois eixos: ordem de 150 m.
    expect(d).toBeGreaterThan(100);
    expect(d).toBeLessThan(200);
  });

  it("GEO-06 atravessar o antimeridiano não vira meia volta no planeta", () => {
    /*
      179.9°E e 179.9°W são vizinhos, não antípodas. Uma implementação que
      subtraísse longitudes sem cuidado devolveria ~20.000 km aqui — e a
      ordenação por proximidade colocaria a caixa ao lado no fim da lista.
    */
    const d = distanceInMeters(
      { latitude: 0, longitude: 179.9 },
      { latitude: 0, longitude: -179.9 },
    );
    expect(d).toBeLessThan(30_000);
  });

  it("GEO-07 antípodas dão meia circunferência", () => {
    const d = distanceInMeters(
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 180 },
    );
    expect(d).toBe(Math.round(Math.PI * RAIO_M));
  });
});

describe("geo · assertValidCoordinate", () => {
  const recusa = (lat: unknown, lng: unknown) => {
    let erro: unknown;
    try {
      assertValidCoordinate(lat, lng);
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(DomainError);
    expect((erro as DomainError).status).toBe(400);
  };

  it("GEO-08 aceita coordenada válida e devolve números", () => {
    expect(assertValidCoordinate(-20.7746, -41.6789)).toEqual({
      latitude: -20.7746,
      longitude: -41.6789,
    });
  });

  it("GEO-09 recusa o que não é número, inclusive string numérica", () => {
    // A guarda é de TIPO antes de ser de faixa: `"-20.7"` não passa, e é
    // deliberado — quem manda string está mandando de um lugar não tipado.
    for (const [lat, lng] of [
      ["-20.7746", "-41.6789"],
      [null, null],
      [undefined, undefined],
      [{}, []],
      [true, false],
    ] as Array<[unknown, unknown]>) {
      recusa(lat, lng);
    }
  });

  it("GEO-10 recusa NaN e Infinity nos dois eixos", () => {
    recusa(Number.NaN, 0);
    recusa(0, Number.NaN);
    recusa(Number.POSITIVE_INFINITY, -41);
    recusa(-20, Number.NEGATIVE_INFINITY);
  });

  it("GEO-11 recusa fora da faixa e aceita os extremos", () => {
    recusa(90.0001, 0);
    recusa(-90.0001, 0);
    recusa(0, 180.0001);
    recusa(0, -180.0001);
    expect(assertValidCoordinate(90, 180)).toEqual({
      latitude: 90,
      longitude: 180,
    });
  });

  it("GEO-12 recusa a ILHA NULA, e só ela entre os zeros", () => {
    /*
      `0,0` fica no Atlântico, ao sul de Gana, e no mundo real significa
      "campo não preenchido" muito mais vezes do que significa aquele ponto.
      A regra vale para o par exato: `0, -41` e `-20, 0` continuam válidos.
    */
    recusa(0, 0);
    expect(assertValidCoordinate(0, -41.6789).longitude).toBe(-41.6789);
    expect(assertValidCoordinate(-20.7746, 0).latitude).toBe(-20.7746);
    expect(coordenadaValida(0, 0)).toBe(false);
  });
});

describe("geo · assertValidAccuracy", () => {
  it("GEO-13 ausência de precisão é válida e vira null", () => {
    // Digitado à mão, geocodificado e importado não informam precisão.
    expect(assertValidAccuracy(null)).toBeNull();
    expect(assertValidAccuracy(undefined)).toBeNull();
  });

  it("GEO-14 arredonda para metro inteiro", () => {
    expect(assertValidAccuracy(12.4)).toBe(12);
    expect(assertValidAccuracy(12.6)).toBe(13);
    expect(assertValidAccuracy(0)).toBe(0);
  });

  it("GEO-15 recusa negativo, não finito e acima do teto", () => {
    for (const valor of [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_ACCURACY_METERS + 1,
    ]) {
      let erro: unknown;
      try {
        assertValidAccuracy(valor);
      } catch (e) {
        erro = e;
      }
      expect(erro).toBeInstanceOf(DomainError);
      expect((erro as DomainError).status).toBe(400);
    }
    // O teto é inclusivo.
    expect(assertValidAccuracy(MAX_ACCURACY_METERS)).toBe(MAX_ACCURACY_METERS);
  });
});
