/**
 * # `SEC-002` · o custo de percorrer a estrutura é limitado
 *
 * ## O achado
 *
 * O JPEG tinha teto de segmentos desde o `PC-1`, e a reescrita de PNG e WebP
 * para lista de permitidos (`RC-EXIF-09`) nasceu **sem o equivalente**. A
 * revisão de segurança independente mediu, com arquivos de 8 MB feitos só de
 * chunks de tamanho zero:
 *
 * | forma | unidades | custo |
 * |---|---|---|
 * | PNG, chunks de tamanho zero | ~699 mil | ~575 ms |
 * | WebP, chunks de topo | ~1,05 milhão | ~715 ms |
 * | WebP, quadros `ANMF` | ~210 mil | ~647 ms |
 *
 * Em Node isso não é uma requisição lenta: é a thread única parada, e com ela
 * **a aplicação inteira, para todos os tenants**. O AlfaOS roda em instância
 * única (`docs/DEPLOYMENT.md`), então não há um segundo processo para atender
 * enquanto este percorre um milhão de chunks forjados.
 *
 * ## O que este arquivo fixa
 *
 * Custo de percurso **determinístico e limitado**, sem depender de quantos
 * bytes o atacante escolheu nem de como ele os arranjou. E o teto do WebP é
 * **total**: um orçamento reiniciado a cada quadro recriaria o percurso sem
 * limite na forma `N quadros × teto`, que é a mesma vulnerabilidade com outra
 * aritmética.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_STRUCTURAL_CHUNKS,
  MAX_JPEG_SEGMENTS,
  stripImageMetadata,
  UnparseableImageError,
} from "@/lib/media/image-metadata";
import { montarPngReal } from "./support/png-real";
import { pngChunk, riff, riffChunk } from "./support/image-containers";

const MB = 1024 * 1024;
const ASSINATURA_PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Teto de tempo das provas de custo.
 *
 * Generoso de propósito: o que está em teste é a ORDEM DE GRANDEZA (o percurso
 * sem teto custava centenas de milissegundos e crescia com o arquivo), não a
 * velocidade da máquina que roda a suíte. Um limite apertado viraria teste
 * instável sob carga, e teste instável é teste que alguém desliga.
 */
const TETO_MS = 150;

function medir(fn: () => void): { ms: number; erro: Error | null } {
  const inicio = process.hrtime.bigint();
  let erro: Error | null = null;
  try {
    fn();
  } catch (e) {
    erro = e as Error;
  }
  return { ms: Number(process.hrtime.bigint() - inicio) / 1e6, erro };
}

/** PNG estruturalmente válido com `quantidade` chunks de tamanho zero. */
function pngComEnxurradaDeChunks(quantidade: number): Buffer {
  const vazio = pngChunk("IDAT", Buffer.alloc(0));
  const partes: Buffer[] = [
    ASSINATURA_PNG,
    pngChunk("IHDR", Buffer.alloc(13)),
    ...Array.from({ length: quantidade }, () => vazio),
    pngChunk("IEND", Buffer.alloc(0)),
  ];
  return Buffer.concat(partes);
}

/** WebP válido com `quantidade` chunks de topo de tamanho zero. */
function webpComEnxurradaDeChunks(quantidade: number): Buffer {
  const vazio = riffChunk("ALPH", Buffer.alloc(0));
  return riff(
    Buffer.concat([
      riffChunk("VP8 ", Buffer.from("imagem")),
      ...Array.from({ length: quantidade }, () => vazio),
    ]),
  );
}

/** WebP animado com `quadros` `ANMF`, cada um com só o cabeçalho fixo. */
function webpComEnxurradaDeQuadros(quadros: number): Buffer {
  const quadro = riffChunk("ANMF", Buffer.alloc(16));
  return riff(
    Buffer.concat([
      riffChunk("VP8X", Buffer.alloc(10)),
      ...Array.from({ length: quadros }, () => quadro),
    ]),
  );
}

/**
 * WebP em que cada quadro carrega `porQuadro` chunks internos.
 *
 * É o vetor da amplificação aninhada: com orçamento por quadro, `quadros ×
 * porQuadro` volta a ser ilimitado mesmo com cada quadro "dentro do teto".
 */
function webpComQuadrosRecheados(quadros: number, porQuadro: number): Buffer {
  const internos = Buffer.concat(
    Array.from({ length: porQuadro }, () => riffChunk("ALPH", Buffer.alloc(0))),
  );
  const quadro = riffChunk("ANMF", Buffer.concat([Buffer.alloc(16), internos]));
  return riff(
    Buffer.concat([
      riffChunk("VP8X", Buffer.alloc(10)),
      ...Array.from({ length: quadros }, () => quadro),
    ]),
  );
}

describe("SEC-002 · PNG", () => {
  it("a enxurrada de chunks de 8 MB é RECUSADA, e rápido", () => {
    const ataque = pngComEnxurradaDeChunks(Math.floor((8 * MB) / 12));
    expect(ataque.length).toBeGreaterThan(8 * MB);

    const { ms, erro } = medir(() => stripImageMetadata(ataque, "image/png"));

    expect(erro).toBeInstanceOf(UnparseableImageError);
    expect(ms).toBeLessThan(TETO_MS);
  });

  it("um PNG logo acima do teto é recusado e logo abaixo é aceito", () => {
    expect(() =>
      stripImageMetadata(pngComEnxurradaDeChunks(MAX_STRUCTURAL_CHUNKS + 10), "image/png"),
    ).toThrow(UnparseableImageError);

    // Dois a menos: o `IHDR` e o `IEND` também são unidades estruturais.
    expect(() =>
      stripImageMetadata(pngComEnxurradaDeChunks(MAX_STRUCTURAL_CHUNKS - 2), "image/png"),
    ).not.toThrow();
  });
});

describe("SEC-002 · WebP", () => {
  it("a enxurrada de chunks de topo de 8 MB é RECUSADA, e rápido", () => {
    const ataque = webpComEnxurradaDeChunks(Math.floor((8 * MB) / 8));
    expect(ataque.length).toBeGreaterThan(8 * MB);

    const { ms, erro } = medir(() => stripImageMetadata(ataque, "image/webp"));

    expect(erro).toBeInstanceOf(UnparseableImageError);
    expect(ms).toBeLessThan(TETO_MS);
  });

  it("a enxurrada de quadros ANMF de 8 MB é RECUSADA, e rápido", () => {
    const ataque = webpComEnxurradaDeQuadros(Math.floor((8 * MB) / 24));
    expect(ataque.length).toBeGreaterThan(8 * MB);

    const { ms, erro } = medir(() => stripImageMetadata(ataque, "image/webp"));

    expect(erro).toBeInstanceOf(UnparseableImageError);
    expect(ms).toBeLessThan(TETO_MS);
  });

  it("o orçamento é TOTAL: quadros dentro do teto não somam um percurso sem teto", () => {
    /*
      Cada quadro tem um oitavo do teto — nenhum deles isoladamente o estoura.
      Oito vezes isso passa do total, e é o total que precisa recusar. Um
      orçamento reiniciado por quadro aceitaria este arquivo.
    */
    const porQuadro = Math.floor(MAX_STRUCTURAL_CHUNKS / 8);
    const ataque = webpComQuadrosRecheados(8, porQuadro);

    const { ms, erro } = medir(() => stripImageMetadata(ataque, "image/webp"));

    expect(erro).toBeInstanceOf(UnparseableImageError);
    expect(ms).toBeLessThan(TETO_MS);
  });

  it("o quadro conta o PRÓPRIO cabeçalho no orçamento", () => {
    // Um quadro só, recheado até o teto: o total estoura dentro do aninhamento.
    expect(() =>
      stripImageMetadata(
        webpComQuadrosRecheados(1, MAX_STRUCTURAL_CHUNKS + 10),
        "image/webp",
      ),
    ).toThrow(UnparseableImageError);
  });
});

describe("SEC-002 · JPEG (o teto que já existia continua valendo)", () => {
  it("a enxurrada de marcadores isolados de 8 MB é RECUSADA, e rápido", () => {
    const n = (8 * MB) / 2;
    const ataque = Buffer.alloc(2 + n * 2);
    ataque[0] = 0xff;
    ataque[1] = 0xd8;
    for (let i = 0; i < n; i++) {
      ataque[2 + i * 2] = 0xff;
      ataque[3 + i * 2] = 0xd0;
    }

    const { ms, erro } = medir(() => stripImageMetadata(ataque, "image/jpeg"));

    expect(erro).toBeInstanceOf(UnparseableImageError);
    expect(ms).toBeLessThan(TETO_MS);
  });

  it("uma enxurrada de SOS vazios também é recusada", () => {
    /*
      O percurso de depois do scan (`SEC-004`) abriu uma unidade estrutural
      nova. `FF DA 00 02` é um scan sem carga e sem dados, quatro bytes, e
      repetido enche o arquivo de unidades tão barato quanto os marcadores
      isolados.
    */
    const n = Math.floor((8 * MB) / 4);
    const partes: Buffer[] = [Buffer.from([0xff, 0xd8])];
    for (let i = 0; i < n; i++) partes.push(Buffer.from([0xff, 0xda, 0x00, 0x02]));
    const ataque = Buffer.concat(partes);

    const { ms, erro } = medir(() => stripImageMetadata(ataque, "image/jpeg"));

    expect(erro).toBeInstanceOf(UnparseableImageError);
    expect(ms).toBeLessThan(TETO_MS);
  });

  it("o teto do JPEG é mais estreito que o dos chunks, e isso é deliberado", () => {
    /*
      Um JPEG de câmera tem DEZENAS de segmentos — o maior do acervo real do
      AlfaOS tem 11. Um PNG grande tem MILHARES de chunks legítimos, porque
      `IDAT` carrega os bytes da imagem em pedaços. Um número só para os dois
      teria de afrouxar o JPEG ou reprovar PNG legítimo.
    */
    expect(MAX_JPEG_SEGMENTS).toBeLessThan(MAX_STRUCTURAL_CHUNKS);
  });
});

describe("SEC-002 · a imagem legítima continua passando", () => {
  it("um PNG real de verdade atravessa", () => {
    const real = montarPngReal(64, 48);
    expect(() => stripImageMetadata(real, "image/png")).not.toThrow();
  });

  it("um PNG com muitos IDAT legítimos atravessa", () => {
    /*
      O caso que decide o VALOR do teto: `libpng` escreve `IDAT` em pedaços do
      tamanho do buffer de compressão (8 KB no padrão), então um PNG de 8 MB
      pode chegar a ~1024 chunks legítimos. O teto precisa ficar acima disso com
      folga, ou a política reprova foto de verdade.
      Aqui: 2048 chunks com carga, o dobro daquele pior caso.
      (No acervo real do AlfaOS o máximo observado é 8 — a folga é enorme.)
    */
    const dados = Buffer.alloc(8, 0x78);
    const png = Buffer.concat([
      ASSINATURA_PNG,
      pngChunk("IHDR", Buffer.alloc(13)),
      ...Array.from({ length: 2048 }, () => pngChunk("IDAT", dados)),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);

    const limpo = stripImageMetadata(png, "image/png");
    expect(limpo.equals(png)).toBe(true);
  });

  it("um WebP animado com muitos quadros legítimos atravessa", () => {
    const quadro = riffChunk(
      "ANMF",
      Buffer.concat([Buffer.alloc(16), riffChunk("VP8 ", Buffer.from("quadro"))]),
    );
    const webp = riff(
      Buffer.concat([
        riffChunk("VP8X", Buffer.alloc(10)),
        ...Array.from({ length: 500 }, () => quadro),
      ]),
    );

    expect(() => stripImageMetadata(webp, "image/webp")).not.toThrow();
  });

  it("um JPEG normal de 8 MB atravessa, e o custo é do tamanho e não da forma", () => {
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xda, 0x00, 0x02]),
      Buffer.alloc(8 * MB, 0x5a),
      Buffer.from([0xff, 0xd9]),
    ]);

    const { ms, erro } = medir(() => stripImageMetadata(jpeg, "image/jpeg"));

    expect(erro).toBeNull();
    expect(ms).toBeLessThan(TETO_MS);
  });
});
