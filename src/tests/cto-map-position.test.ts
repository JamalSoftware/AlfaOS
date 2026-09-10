import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { PATCH as patchRoute } from "@/app/api/ctos/[id]/route";
import { createCto } from "@/lib/cto";
import { getCtoMapView } from "@/lib/cto-map";
import {
  apiRequest,
  createTokenFor,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # `CTO-3.2.1d` — o ADMIN corrige a posição da CTO pelo mapa
 *
 * ## A afirmação central destes testes é sobre o que NÃO foi construído
 *
 * Não existe rota nova, não existe serviço novo e não existe validação nova. O
 * mapa manda `{ latitude, longitude }` para o **mesmo** `PATCH /api/ctos/[id]`
 * que a tela de detalhe usa, e é `updateCto` — com `assertCoordinates` dentro —
 * quem decide se aquilo é uma coordenada.
 *
 * Uma segunda implementação seria uma segunda autoridade sobre a mesma regra, e
 * a que divergisse seria a que ninguém revisou. Por isso `POS-11` afirma sobre a
 * ausência de um caminho paralelo, e não apenas sobre o sucesso do caminho bom.
 *
 * ## O que muda de verdade nesta fase
 *
 * O **payload**. Mandando só o par, `updateCto` monta um `data` que contém só o
 * par: mover a caixa não tem como tocar nome, capacidade, estado ou observações,
 * porque esses campos nem são lidos.
 */

let fixture: TestFixture;
let adminToken: string;

const ORIGIN = { Origin: "http://localhost" };
const LAT_ORIGINAL = -20.7659752;
const LON_ORIGINAL = -41.672622;
const LAT_NOVA = -20.766512;
const LON_NOVA = -41.673104;

beforeEach(async () => {
  fixture = await seedTestData();
  adminToken = await createTokenFor(fixture.adminA.id);
  for (const id of [fixture.companyA.id, fixture.companyB.id]) {
    await prisma.company.update({
      where: { id },
      data: { ctoNetworkEnabled: true },
    });
  }
});

async function criarCaixa(
  companyId = fixture.companyA.id,
  autorId = fixture.adminA.id,
  nome = "A16",
) {
  return createCto(companyId, autorId, {
    name: nome,
    capacity: 4,
    latitude: LAT_ORIGINAL,
    longitude: LON_ORIGINAL,
    addressReference: "Poste em frente ao 240",
    notes: "Observação que não pode ser tocada por um arrasto.",
  });
}

/** O `PATCH` como o mapa o faz: token, origem e SÓ o par de coordenadas. */
async function moverPeloMapa(
  ctoId: string,
  body: Record<string, unknown>,
  token = adminToken,
) {
  const res = await patchRoute(
    apiRequest(
      `/api/ctos/${ctoId}`,
      { method: "PATCH", body, headers: { ...ORIGIN } },
      token,
    ),
    { params: { id: ctoId } },
  );
  return { status: res.status, body: await res.json() };
}

/** A linha crua, para comparar campo a campo. */
async function linhaDoBanco(ctoId: string) {
  const linha = await prisma.cTO.findUniqueOrThrow({ where: { id: ctoId } });
  return {
    latitude: linha.latitude?.toString() ?? null,
    longitude: linha.longitude?.toString() ?? null,
    name: linha.name,
    capacity: linha.capacity,
    active: linha.active,
    addressReference: linha.addressReference,
    notes: linha.notes,
    code: linha.code,
  };
}

describe("POS-01..POS-04 — quem pode mover a caixa", () => {
  it("POS-01 · ADMIN move a coordenada da CTO da própria empresa", async () => {
    const cto = await criarCaixa();

    const { status } = await moverPeloMapa(cto.id, {
      latitude: LAT_NOVA,
      longitude: LON_NOVA,
    });
    expect(status).toBe(200);

    const linha = await linhaDoBanco(cto.id);
    expect(Number(linha.latitude)).toBeCloseTo(LAT_NOVA, 6);
    expect(Number(linha.longitude)).toBeCloseTo(LON_NOVA, 6);
  });

  it("POS-02 · DISPATCHER lê o mapa e NÃO move", async () => {
    const cto = await criarCaixa();
    const token = await createTokenFor(fixture.dispatcherA.id);

    const { status } = await moverPeloMapa(
      cto.id,
      { latitude: LAT_NOVA, longitude: LON_NOVA },
      token,
    );
    /*
      403 e não 404: a empresa TEM a capability, e o DISPATCHER sabe que o
      módulo existe — ele lê o mapa. Esconder a existência aqui seria mentir
      para quem já viu a caixa na tela. O 404 é reservado para capability
      desligada, onde revelar a existência do módulo é que seria o vazamento.
    */
    expect(status).toBe(403);

    const linha = await linhaDoBanco(cto.id);
    expect(Number(linha.latitude)).toBeCloseTo(LAT_ORIGINAL, 6);
    expect(Number(linha.longitude)).toBeCloseTo(LON_ORIGINAL, 6);
  });

  it("POS-03 · TECHNICIAN não ganha a permissão por efeito colateral", async () => {
    const cto = await criarCaixa();
    const token = await createTokenFor(fixture.techA.id);

    const { status } = await moverPeloMapa(
      cto.id,
      { latitude: LAT_NOVA, longitude: LON_NOVA },
      token,
    );
    expect(status).toBe(403);

    const linha = await linhaDoBanco(cto.id);
    expect(Number(linha.latitude)).toBeCloseTo(LAT_ORIGINAL, 6);
  });

  it("POS-04 · ADMIN da empresa A não move CTO da empresa B", async () => {
    const alheia = await criarCaixa(
      fixture.companyB.id,
      fixture.adminB.id,
      "CAIXA DA EMPRESA B",
    );
    const antes = await linhaDoBanco(alheia.id);

    const { status } = await moverPeloMapa(alheia.id, {
      latitude: LAT_NOVA,
      longitude: LON_NOVA,
    });

    /*
      404, e não 403: id de outra empresa não pode ser distinguível de id
      inexistente, senão a resposta de erro vira um oráculo de existência —
      alguém varreria ids e descobriria quais caixas a concorrente tem.
    */
    expect(status).toBe(404);

    /*
      E a prova que importa não é o status: é a linha da empresa B
      **byte a byte** igual. Um endpoint pode recusar e ainda assim ter escrito
      antes de recusar.
    */
    expect(await linhaDoBanco(alheia.id)).toEqual(antes);
  });

  it("POS-04b · o id do caminho NUNCA substitui o filtro de empresa", async () => {
    /*
      O vetor real: o token é legítimo, a empresa é legítima, e só o id aponta
      para fora. Se a escrita alcançasse a linha por id sozinho, isto passaria.
    */
    const minha = await criarCaixa();
    const alheia = await criarCaixa(
      fixture.companyB.id,
      fixture.adminB.id,
      "OUTRA DA B",
    );

    const antesB = await linhaDoBanco(alheia.id);
    await moverPeloMapa(alheia.id, {
      latitude: LAT_NOVA,
      longitude: LON_NOVA,
    });

    expect(await linhaDoBanco(alheia.id)).toEqual(antesB);
    // E a minha continua intocada: a recusa não escreveu no lugar errado.
    const linhaA = await linhaDoBanco(minha.id);
    expect(Number(linhaA.latitude)).toBeCloseTo(LAT_ORIGINAL, 6);
  });
});

describe("POS-05..POS-09 — o que o servidor recusa, e o que sobra depois", () => {
  it("POS-05 · latitude fora da faixa é recusada, nomeando o campo", async () => {
    const cto = await criarCaixa();

    const { status, body } = await moverPeloMapa(cto.id, {
      latitude: 91,
      longitude: LON_NOVA,
    });
    expect(status).toBe(400);
    expect(body.error).toContain("Latitude");
    expect(body.field).toBe("latitude");

    const linha = await linhaDoBanco(cto.id);
    expect(Number(linha.latitude)).toBeCloseTo(LAT_ORIGINAL, 6);
    expect(Number(linha.longitude)).toBeCloseTo(LON_ORIGINAL, 6);
  });

  it("POS-06 · longitude fora da faixa é recusada, nomeando o campo", async () => {
    const cto = await criarCaixa();

    const { status, body } = await moverPeloMapa(cto.id, {
      latitude: LAT_NOVA,
      longitude: 181,
    });
    expect(status).toBe(400);
    expect(body.field).toBe("longitude");

    const linha = await linhaDoBanco(cto.id);
    expect(Number(linha.longitude)).toBeCloseTo(LON_ORIGINAL, 6);
  });

  it("POS-05b · NaN e Infinity não passam pela forma", async () => {
    const cto = await criarCaixa();

    /*
      `JSON.stringify` converte `NaN` e `Infinity` em `null`, então pelo
      transporte eles chegam como "limpe a coordenada". Quem os produz de
      verdade é um chamador direto ou um corpo montado à mão — e é por isso que
      o `zod` exige `finite()` antes de o domínio comparar faixa: comparação com
      `NaN` é sempre falsa, e um teste de faixa sozinho o deixaria passar.
    */
    for (const valor of ["NaN", "Infinity", "-Infinity"]) {
      /*
        `Request` montada à mão, e não pelo helper: ele serializa com
        `JSON.stringify`, que é justamente o que converteria estes valores em
        `null` antes de saírem. Estender o helper compartilhado por causa de um
        teste seria pior — ele passaria a permitir corpos que a produção não
        produz.
      */
      const res = await patchRoute(
        new Request(`http://localhost/api/ctos/${cto.id}`, {
          method: "PATCH",
          headers: {
            ...ORIGIN,
            "Content-Type": "application/json",
            Cookie: `alfaos_session=${encodeURIComponent(adminToken)}`,
          },
          body: `{"latitude":${valor},"longitude":${LON_NOVA}}`,
        }),
        { params: { id: cto.id } },
      );
      expect(res.status, `${valor} passou`).toBe(400);
    }

    const linha = await linhaDoBanco(cto.id);
    expect(Number(linha.latitude)).toBeCloseTo(LAT_ORIGINAL, 6);
  });

  it("POS-05c · coordenada 0 é VÁLIDA, e não um valor suspeito", async () => {
    /*
      Zero é geografia: a linha do Equador e o meridiano de Greenwich existem.
      Proibir `0` porque "parece falso" recusaria uma coordenada legítima.

      O que a `CTO-1` proíbe é FABRICAR `0,0` quando não há posição — e isso é
      outra coisa: ninguém inventa, mas quem informar é aceito.
    */
    const cto = await criarCaixa();

    const { status } = await moverPeloMapa(cto.id, {
      latitude: 0,
      longitude: 0,
    });
    expect(status).toBe(200);

    const linha = await linhaDoBanco(cto.id);
    expect(Number(linha.latitude)).toBe(0);
    expect(Number(linha.longitude)).toBe(0);
  });

  it("POS-05d · meia coordenada é recusada", async () => {
    const cto = await criarCaixa();

    const { status, body } = await moverPeloMapa(cto.id, {
      latitude: LAT_NOVA,
      longitude: null,
    });
    expect(status).toBe(400);
    expect(body.error).toContain("incompletas");

    const linha = await linhaDoBanco(cto.id);
    expect(Number(linha.longitude)).toBeCloseTo(LON_ORIGINAL, 6);
  });

  it("POS-09 · recusa não deixa alteração parcial", async () => {
    const cto = await criarCaixa();
    const antes = await linhaDoBanco(cto.id);

    await moverPeloMapa(cto.id, { latitude: 91, longitude: 181 });

    // A linha INTEIRA igual: uma recusa que gravasse metade seria pior que uma
    // que gravasse tudo, porque ninguém iria procurar por ela.
    expect(await linhaDoBanco(cto.id)).toEqual(antes);
  });
});

describe("POS-07/POS-08 — mover é uma operação ESTREITA", () => {
  it("POS-07 · campo extra no payload é recusado, e nada é alterado", async () => {
    const cto = await criarCaixa();
    const antes = await linhaDoBanco(cto.id);

    /*
      O ataque de mass assignment aplicado a esta fase: aproveitar uma operação
      de posição para desativar a caixa e encolher a capacidade.

      O schema é `.strict()`, então o corpo inteiro é recusado — e recusar é
      melhor que remover em silêncio, porque quem mandou fica sabendo.
    */
    const { status } = await moverPeloMapa(cto.id, {
      latitude: LAT_NOVA,
      longitude: LON_NOVA,
      active: false,
      capacity: 2,
    });
    expect(status).toBe(400);

    expect(await linhaDoBanco(cto.id)).toEqual(antes);
  });

  it("POS-07b · nem mesmo campos LEGÍTIMOS entram de carona", async () => {
    /*
      `name` e `notes` são aceitos pela rota — a tela de detalhe os usa. O ponto
      aqui é que o MAPA não os envia, e por isso mover não tem como alterá-los.

      Provado pelo caminho oposto: mandando os dois junto, eles seriam gravados.
      É a diferença entre "a rota não deixa" e "o mapa não pede", e só a segunda
      é verdade — o que torna o payload estreito uma decisão, não um acidente.
    */
    const cto = await criarCaixa();

    const { status } = await moverPeloMapa(cto.id, {
      latitude: LAT_NOVA,
      longitude: LON_NOVA,
      name: "NOME TROCADO PELO MAPA",
    });
    expect(status).toBe(200);
    expect((await linhaDoBanco(cto.id)).name).toBe("NOME TROCADO PELO MAPA");
  });

  it("POS-08 · o payload do mapa altera SOMENTE latitude e longitude", async () => {
    const cto = await criarCaixa();
    const antes = await linhaDoBanco(cto.id);

    const { status } = await moverPeloMapa(cto.id, {
      latitude: LAT_NOVA,
      longitude: LON_NOVA,
    });
    expect(status).toBe(200);

    const depois = await linhaDoBanco(cto.id);

    // Campo a campo: só o par mudou.
    expect(Number(depois.latitude)).toBeCloseTo(LAT_NOVA, 6);
    expect(Number(depois.longitude)).toBeCloseTo(LON_NOVA, 6);
    expect(depois.name).toBe(antes.name);
    expect(depois.capacity).toBe(antes.capacity);
    expect(depois.active).toBe(antes.active);
    expect(depois.addressReference).toBe(antes.addressReference);
    expect(depois.notes).toBe(antes.notes);
    expect(depois.code).toBe(antes.code);
  });

  it("POS-08b · o cliente NÃO reenvia o objeto inteiro da CTO", async () => {
    /*
      A garantia contra lost update, e ela é estrutural: o corpo que o mapa monta
      tem duas chaves.

      Se ele mandasse o objeto que leu antes, uma edição feita na tela de detalhe
      entre a leitura do mapa e o clique em salvar seria desfeita — sem erro,
      sem conflito, sem ninguém notar.
    */
    const fonte = readFileSync(
      path.resolve(__dirname, "..", "components", "map", "CtoMapLayer.tsx"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");

    const corpo = /body: JSON\.stringify\(\{([\s\S]*?)\}\)/.exec(fonte);
    expect(corpo, "não achei o corpo do PATCH do mapa").not.toBeNull();

    const chaves = corpo![1]
      .split(",")
      .map((p) => p.split(":")[0].trim())
      .filter(Boolean);
    expect(chaves.sort()).toEqual(["latitude", "longitude"]);
  });
});

describe("POS-10/POS-11 — a leitura confirma, e a autoridade é uma só", () => {
  it("POS-10 · a coordenada nova reaparece na leitura do mapa", async () => {
    const cto = await criarCaixa();

    await moverPeloMapa(cto.id, {
      latitude: LAT_NOVA,
      longitude: LON_NOVA,
    });

    /*
      A leitura CANÔNICA, e não o eco da resposta do PATCH.

      É o que a tela faz depois de salvar: relê o recorte. Se a escrita gravasse
      num lugar e a leitura buscasse noutro, o marcador voltaria ao ponto antigo
      no refresh — e o operador concluiria que o salvamento falhou em silêncio.
    */
    const vista = await getCtoMapView(fixture.companyA.id, {
      bbox: {
        north: LAT_NOVA + 0.01,
        south: LAT_NOVA - 0.01,
        east: LON_NOVA + 0.01,
        west: LON_NOVA - 0.01,
      },
    });

    const marcador = vista.markers.find((m) => m.id === cto.id);
    expect(marcador, "a caixa sumiu do recorte novo").toBeDefined();
    expect(marcador!.latitude).toBeCloseTo(LAT_NOVA, 6);
    expect(marcador!.longitude).toBeCloseTo(LON_NOVA, 6);
  });

  it("POS-10b · mover NÃO altera o estado derivado da caixa", async () => {
    const cto = await criarCaixa();
    const antes = await getCtoMapView(fixture.companyA.id, {
      bbox: {
        north: LAT_ORIGINAL + 0.01,
        south: LAT_ORIGINAL - 0.01,
        east: LON_ORIGINAL + 0.01,
        west: LON_ORIGINAL - 0.01,
      },
    });
    const statusAntes = antes.markers.find((m) => m.id === cto.id)!.status;

    await moverPeloMapa(cto.id, { latitude: LAT_NOVA, longitude: LON_NOVA });

    const depois = await getCtoMapView(fixture.companyA.id, {
      bbox: {
        north: LAT_NOVA + 0.01,
        south: LAT_NOVA - 0.01,
        east: LON_NOVA + 0.01,
        west: LON_NOVA - 0.01,
      },
    });
    const marcador = depois.markers.find((m) => m.id === cto.id)!;

    // Posição é geografia; estado é operação. Uma não deriva da outra.
    expect(marcador.status).toBe(statusAntes);
    expect(marcador.summary.capacity).toBe(4);
    expect(marcador.summary.free).toBe(4);
  });

  it("POS-11 · o mapa reaproveita a rota e o serviço da tela de detalhe", async () => {
    /*
      A afirmação é sobre a AUSÊNCIA de um segundo caminho.

      Uma rota `/location` própria seria uma segunda autoridade sobre a mesma
      regra de coordenada, e a que divergisse seria a que ninguém revisou — o
      defeito que a `CTO-1.6` já pagou quando rota e domínio conheciam a faixa
      `-90..90` ao mesmo tempo.
    */
    const camada = readFileSync(
      path.resolve(__dirname, "..", "components", "map", "CtoMapLayer.tsx"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");

    expect(camada).toMatch(/fetch\(`\/api\/ctos\/\$\{[^}]+\}`/);
    expect(camada, "o mapa criou um caminho próprio de posição").not.toMatch(
      /\/location|\/position|\/coordinates/,
    );

    // E a validação continua morando no domínio, e não na camada de tela.
    expect(camada).not.toContain("-90");
    expect(camada).not.toContain("180");
  });

  it("POS-12 · mover a caixa não toca em ERP nenhum", async () => {
    /*
      A posição da CTO é do AlfaOS. Ela precisa continuar funcionando qualquer
      que seja o ERP configurado — inclusive nenhum.

      A empresa do fixture não tem integração de ERP alguma, e a operação
      conclui. Se algum caminho de posição consultasse provider, isto falharia
      por ausência de credencial.
    */
    const integracoes = await prisma.eRPIntegration.count({
      where: { companyId: fixture.companyA.id },
    });
    expect(integracoes, "o fixture ganhou ERP e o teste perdeu o sentido").toBe(0);

    const cto = await criarCaixa();
    const { status } = await moverPeloMapa(cto.id, {
      latitude: LAT_NOVA,
      longitude: LON_NOVA,
    });
    expect(status).toBe(200);

    const camada = readFileSync(
      path.resolve(__dirname, "..", "components", "map", "CtoMapLayer.tsx"),
      "utf8",
    );
    for (const proibido of ["receitanet", "ReceitaNet", "SGP", "erpProvider"]) {
      expect(camada, `a camada do mapa cita ${proibido}`).not.toContain(proibido);
    }
  });
});

describe("POS-AUD — a trilha de auditoria", () => {
  it("POS-AUD-01 · mover registra CTO.UPDATED com o DE e o PARA", async () => {
    const cto = await criarCaixa();

    await moverPeloMapa(cto.id, { latitude: LAT_NOVA, longitude: LON_NOVA });

    const trilha = await prisma.auditLog.findMany({
      where: { companyId: fixture.companyA.id, entityId: cto.id },
      orderBy: { createdAt: "desc" },
    });
    const registro = trilha.find((l) => l.action === "CTO.UPDATED");

    expect(registro, "mover não deixou trilha").toBeDefined();
    expect(registro!.userId).toBe(fixture.adminA.id);
    expect(registro!.entity).toBe("CTO");

    /*
      Coordenada é o caso em que o CONTEÚDO cabe na trilha.

      A regra do módulo é registrar nomes de campos, e não o texto alterado —
      uma observação pode ter parágrafos, e a auditoria não é lugar de copiá-los.
      Coordenada é diferente: são dois números, e o valor É a informação
      auditável. "As coordenadas mudaram" não responde a pergunta que se faz
      seis meses depois, que é *para onde*.

      E ela não é dado pessoal: o schema já registra que a coordenada é da
      CAIXA, pública por natureza, porque a caixa fica no poste.
    */
    expect(registro!.details).toContain("coordenadas");
    expect(registro!.details, "a trilha não diz de onde saiu").toContain(
      LAT_ORIGINAL.toFixed(6),
    );
    expect(registro!.details, "a trilha não diz para onde foi").toContain(
      LAT_NOVA.toFixed(6),
    );
  });

  it("POS-AUD-02 · salvar a MESMA posição não polui a trilha", async () => {
    const cto = await criarCaixa();
    const antes = await prisma.auditLog.count({
      where: { companyId: fixture.companyA.id, action: "CTO.UPDATED" },
    });

    const { status } = await moverPeloMapa(cto.id, {
      latitude: LAT_ORIGINAL,
      longitude: LON_ORIGINAL,
    });
    expect(status).toBe(200);

    // Auditoria que registra não-mudança é ruído que esconde a mudança real.
    const depois = await prisma.auditLog.count({
      where: { companyId: fixture.companyA.id, action: "CTO.UPDATED" },
    });
    expect(depois).toBe(antes);
  });

  it("POS-AUD-03 · a regra de NÃO copiar texto livre continua valendo", async () => {
    /*
      O alargamento é da coordenada, e só dela. Se `notes` passasse a aparecer na
      trilha, um texto longo — possivelmente com dado de cliente — vazaria para
      uma tabela que ninguém revisa com esse olhar.
    */
    const cto = await criarCaixa();
    const segredo = "OBSERVACAO-QUE-NAO-PODE-VAZAR-PARA-A-TRILHA";

    await moverPeloMapa(cto.id, { notes: segredo });

    const trilha = await prisma.auditLog.findMany({
      where: { companyId: fixture.companyA.id, entityId: cto.id },
    });
    for (const linha of trilha) {
      expect(linha.details ?? "").not.toContain(segredo);
    }
  });
});
