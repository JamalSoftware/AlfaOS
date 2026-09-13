import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AccessProfile } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  loadGlobalSearch,
  searchGlobal,
  type GlobalSearchResult,
  type GlobalSearchType,
  type GlobalSearchViewer,
} from "@/lib/global-search";
import { GLOBAL_SEARCH_PER_TYPE, parseGlobalSearchQuery } from "@/lib/global-search-rules";
import { listCompanyCustomers } from "@/lib/customers";
import { listCompanyServiceOrders } from "@/lib/service-orders";
import { listCompanyTechnicians } from "@/lib/technicians";
import { allocateTestServiceOrderNumber, seedTestData, type TestFixture } from "./helpers";

/**
 * # GS-1 — Busca global (PRD §384, MASTER-PLAN §7)
 *
 * Tudo contra o Postgres real. Cada negação tem controle positivo: o registro que
 * a outra empresa NÃO pode ver é achado pela própria.
 */

let fixture: TestFixture;
let seq = 0;

beforeEach(async () => {
  fixture = await seedTestData();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const como = (companyId: string, profile: AccessProfile): GlobalSearchViewer => ({ companyId, profile });
const adminA = () => como(fixture.companyA.id, AccessProfile.ADMIN);
const despachoA = () => como(fixture.companyA.id, AccessProfile.DISPATCHER);
const adminB = () => como(fixture.companyB.id, AccessProfile.ADMIN);

async function cliente(companyId: string, data: Record<string, unknown> = {}) {
  seq += 1;
  return prisma.customer.create({
    data: { companyId, name: `QA GS Cliente ${seq}`, ...data },
  });
}

async function ordem(companyId: string, customerId: string, data: Record<string, unknown> = {}) {
  return prisma.serviceOrder.create({
    data: {
      companyId,
      number: await allocateTestServiceOrderNumber(companyId),
      customerId,
      type: "Instalação",
      description: "QA GS",
      ...data,
    },
  });
}

async function tecnico(companyId: string, name: string, active = true) {
  seq += 1;
  const user = await prisma.user.create({
    data: {
      companyId,
      name,
      email: `qa.gs.${seq}.${Date.now()}@sintetico.local`,
      profile: AccessProfile.TECHNICIAN,
      passwordHash: "x",
    },
  });
  return prisma.technician.create({ data: { companyId, userId: user.id, active } });
}

async function ligarRede(companyId: string) {
  await prisma.company.update({ where: { id: companyId }, data: { ctoNetworkEnabled: true } });
}

function ok(r: GlobalSearchResult) {
  if (r.state !== "ok") throw new Error(`esperava resultado, veio ${r.state}`);
  return r;
}

function ids(r: GlobalSearchResult, type: GlobalSearchType): string[] {
  return ok(r).groups.find((g) => g.type === type)?.hits.map((h) => h.id) ?? [];
}

function tipos(r: GlobalSearchResult): GlobalSearchType[] {
  return ok(r).groups.map((g) => g.type);
}

describe("GS-DOM — tenancy", () => {
  it("GS-DOM-01 — mesmo nome, telefone, documento e número de OS: cada empresa só acha o que é dela", async () => {
    await ligarRede(fixture.companyA.id);
    await ligarRede(fixture.companyB.id);
    const dados = { name: "QA GS Maria Gêmea", phone: "92999990001", document: "11122233344" };
    const a = await cliente(fixture.companyA.id, dados);
    const b = await cliente(fixture.companyB.id, dados);
    const osA = await ordem(fixture.companyA.id, a.id);
    const osB = await ordem(fixture.companyB.id, b.id);
    const tecA = await tecnico(fixture.companyA.id, "QA GS Técnico Gêmeo");
    const tecB = await tecnico(fixture.companyB.id, "QA GS Técnico Gêmeo");
    const ctoA = await prisma.cTO.create({ data: { companyId: fixture.companyA.id, name: "QA GS Caixa Gêmea", capacity: 8 } });
    const ctoB = await prisma.cTO.create({ data: { companyId: fixture.companyB.id, name: "QA GS Caixa Gêmea", capacity: 8 } });

    for (const termo of ["QA GS Maria Gêmea", "92999990001", "(92) 99999-0001", "111.222.333-44"]) {
      const deA = await searchGlobal(adminA(), termo);
      const deB = await searchGlobal(adminB(), termo);
      expect(ids(deA, "CUSTOMER"), termo).toEqual([a.id]);
      expect(ids(deB, "CUSTOMER"), termo).toEqual([b.id]);
    }
    expect(ids(await searchGlobal(adminA(), String(osA.number)), "SERVICE_ORDER")).toContain(osA.id);
    expect(ids(await searchGlobal(adminA(), String(osA.number)), "SERVICE_ORDER")).not.toContain(osB.id);
    expect(ids(await searchGlobal(adminB(), String(osB.number)), "SERVICE_ORDER")).toContain(osB.id);
    expect(ids(await searchGlobal(adminA(), "Técnico Gêmeo"), "TECHNICIAN")).toEqual([tecA.id]);
    expect(ids(await searchGlobal(adminB(), "Técnico Gêmeo"), "TECHNICIAN")).toEqual([tecB.id]);
    expect(ids(await searchGlobal(adminA(), "Caixa Gêmea"), "CTO")).toEqual([ctoA.id]);
    expect(ids(await searchGlobal(adminB(), "Caixa Gêmea"), "CTO")).toEqual([ctoB.id]);
  });

  it("GS-DOM-02 — OS apontando para cliente de OUTRA empresa não casa pelo nome dele nem o mostra", async () => {
    // O banco aceita: ServiceOrder.customerId é FK simples (vetor da DQ-7.1).
    const intrusa = await cliente(fixture.companyB.id, { name: "QA GS Intrusa Bê" });
    const osA = await ordem(fixture.companyA.id, intrusa.id);

    const porNome = await searchGlobal(adminA(), "Intrusa Bê");
    expect(ok(porNome).groups).toEqual([]);

    const porNumero = ok(await searchGlobal(adminA(), String(osA.number)));
    const hit = porNumero.groups.find((g) => g.type === "SERVICE_ORDER")?.hits.find((h) => h.id === osA.id);
    expect(hit).toBeDefined();
    expect(JSON.stringify(porNumero)).not.toContain("Intrusa");

    // A listagem /ordens usa o MESMO predicado e ganhou o mesmo endurecimento.
    const listagem = await listCompanyServiceOrders(fixture.companyA.id, { search: "Intrusa Bê" });
    expect(listagem.serviceOrders.map((o) => o.id)).not.toContain(osA.id);
  });
});

describe("GS-DOM — perfis", () => {
  it("GS-DOM-03 — ADMIN com a rede ligada recebe os quatro tipos; sem a rede, sem CTO", async () => {
    const c = await cliente(fixture.companyA.id, { name: "QA GS Perfil Único" });
    await ordem(fixture.companyA.id, c.id, { description: "QA GS Perfil Único na OS" });
    await tecnico(fixture.companyA.id, "QA GS Perfil Único Técnico");
    await prisma.cTO.create({ data: { companyId: fixture.companyA.id, name: "QA GS Perfil Único CTO", capacity: 8 } });

    expect(tipos(await searchGlobal(adminA(), "Perfil Único"))).toEqual(["CUSTOMER", "SERVICE_ORDER", "TECHNICIAN"]);
    await ligarRede(fixture.companyA.id);
    expect(tipos(await searchGlobal(adminA(), "Perfil Único"))).toEqual([
      "CUSTOMER",
      "SERVICE_ORDER",
      "CTO",
      "TECHNICIAN",
    ]);
  });

  it("GS-DOM-04 — DISPATCHER recebe clientes, OS e técnicos, e nunca CTO (a listagem /ctos é do ADMIN)", async () => {
    await ligarRede(fixture.companyA.id);
    const c = await cliente(fixture.companyA.id, { name: "QA GS Despacho Vê" });
    await ordem(fixture.companyA.id, c.id);
    await tecnico(fixture.companyA.id, "QA GS Despacho Vê Técnico");
    await prisma.cTO.create({ data: { companyId: fixture.companyA.id, name: "QA GS Despacho Vê CTO", capacity: 8 } });

    const r = await searchGlobal(despachoA(), "Despacho Vê");
    expect(tipos(r)).toEqual(["CUSTOMER", "SERVICE_ORDER", "TECHNICIAN"]);
    // Controle positivo: a caixa existe e o ADMIN a acha.
    expect(tipos(await searchGlobal(adminA(), "Despacho Vê"))).toContain("CTO");
  });

  it("GS-DOM-05 — TECHNICIAN não tem busca global: o domínio recusa, e a tela converte em erro", async () => {
    await cliente(fixture.companyA.id, { name: "QA GS Proibido" });
    const tecnicoA = como(fixture.companyA.id, AccessProfile.TECHNICIAN);
    await expect(searchGlobal(tecnicoA, "Proibido")).rejects.toMatchObject({ status: 403 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await loadGlobalSearch(tecnicoA, "Proibido")).state).toBe("error");
  });
});

describe("GS-DOM — campos e termos", () => {
  it("GS-DOM-06 — cliente por nome, documento, e-mail, telefone 1 e 2, endereço, bairro, cidade e CEP", async () => {
    const c = await cliente(fixture.companyA.id, {
      name: "QA GS Ana Completa",
      document: "123.456.789-09",
      email: "ana.completa@qa-gs.local",
      phone: "92988887777",
      secondaryPhone: "(92) 3222-1111",
      address: "Rua das Seringueiras",
      district: "Adrianópolis",
      city: "Manaus",
      state: "AM",
      zipCode: "69057-000",
    });
    for (const termo of [
      "ana completa",
      "123.456.789-09",
      "ana.completa@qa-gs",
      "92988887777",
      "(92) 98888-7777",
      "3222-1111",
      "Seringueiras",
      "Adrianópolis",
      "69057-000",
    ]) {
      expect(ids(await searchGlobal(adminA(), termo), "CUSTOMER"), termo).toEqual([c.id]);
    }
    expect(ids(await searchGlobal(adminA(), "Manaus"), "CUSTOMER")).toContain(c.id);
    // A listagem /clientes usa o MESMO predicado: acha pelo endereço também.
    const listagem = await listCompanyCustomers(fixture.companyA.id, { search: "Seringueiras" });
    expect(listagem.customers.map((x) => x.id)).toEqual([c.id]);
  });

  it("GS-DOM-07 — número de OS: '7', '#7', 'OS 7', 'Nº 7' acham só a OS; um dígito não busca telefone", async () => {
    const c = await cliente(fixture.companyA.id, { name: "QA GS Sete", phone: "92977777777" });
    const os = await ordem(fixture.companyA.id, c.id);
    for (const termo of [String(os.number), `#${os.number}`, `OS ${os.number}`, `Nº ${os.number}`, `os nº ${os.number}`]) {
      const r = ok(await searchGlobal(adminA(), termo));
      expect(ids(r, "SERVICE_ORDER")[0], termo).toBe(os.id);
    }
    if (String(os.number).length === 1) {
      expect(ids(await searchGlobal(adminA(), String(os.number)), "CUSTOMER")).toEqual([]);
    }
  });

  it("GS-DOM-08 — a OS do número exato vem primeiro, mesmo com OS mais novas citando o número no texto", async () => {
    const c = await cliente(fixture.companyA.id, { name: "QA GS Ordem Exata" });
    const alvo = await ordem(fixture.companyA.id, c.id, { createdAt: new Date(Date.now() - 86_400_000) });
    for (let i = 0; i < GLOBAL_SEARCH_PER_TYPE + 2; i += 1) {
      await ordem(fixture.companyA.id, c.id, { description: `cita a OS ${alvo.number} no texto` });
    }
    const r = ok(await searchGlobal(adminA(), `OS ${alvo.number}`));
    const grupo = r.groups.find((g) => g.type === "SERVICE_ORDER")!;
    expect(grupo.hits[0].id).toBe(alvo.id);
    expect(grupo.hits).toHaveLength(GLOBAL_SEARCH_PER_TYPE);
    expect(grupo.truncated).toBe(true);
  });

  it("GS-DOM-08b — a OS achada pelo número E pelo texto aparece uma vez só", async () => {
    const c = await cliente(fixture.companyA.id, { name: "QA GS Sem Duplicar" });
    let ultima = await ordem(fixture.companyA.id, c.id);
    while (ultima.number < 10) ultima = await ordem(fixture.companyA.id, c.id);
    // "10" casa a OS Nº 10 no número exato e no predicado da listagem (que
    // também tem o número): as duas consultas a devolvem.
    const r = ok(await searchGlobal(adminA(), String(ultima.number)));
    const hits = r.groups.find((g) => g.type === "SERVICE_ORDER")!.hits;
    expect(hits.filter((h) => h.id === ultima.id)).toHaveLength(1);
    expect(new Set(hits.map((h) => h.id)).size).toBe(hits.length);
  });

  it("GS-DOM-09 — teto por tipo, informado, e o 'ver todos' abre a listagem de mesmo predicado", async () => {
    for (let i = 0; i < GLOBAL_SEARCH_PER_TYPE + 2; i += 1) {
      await cliente(fixture.companyA.id, { name: `QA GS Lote ${i}` });
    }
    const r = ok(await searchGlobal(adminA(), "QA GS Lote"));
    const grupo = r.groups.find((g) => g.type === "CUSTOMER")!;
    expect(grupo.hits).toHaveLength(GLOBAL_SEARCH_PER_TYPE);
    expect(grupo.truncated).toBe(true);
    expect(grupo.moreHref).toBe("/clientes?search=QA%20GS%20Lote");
    const listagem = await listCompanyCustomers(fixture.companyA.id, { search: "QA GS Lote" });
    expect(listagem.total).toBe(GLOBAL_SEARCH_PER_TYPE + 2);
    // Sem passar do teto, não há "ver todos".
    const um = ok(await searchGlobal(adminA(), "QA GS Lote 1"));
    expect(um.groups[0].truncated).toBe(false);
    expect(um.groups[0].moreHref).toBeNull();
  });

  it("GS-DOM-10 — termo vazio, curto, só curinga ou longo demais não consulta nada", async () => {
    await cliente(fixture.companyA.id, { name: "QA GS Qualquer" });
    const espiao = vi.spyOn(prisma, "$transaction");
    expect(await searchGlobal(adminA(), undefined)).toEqual({ state: "idle" });
    expect(await searchGlobal(adminA(), "   ")).toEqual({ state: "idle" });
    expect((await searchGlobal(adminA(), "a")).state).toBe("too-short");
    expect((await searchGlobal(adminA(), "%%")).state).toBe("too-short");
    expect((await searchGlobal(adminA(), "a%")).state).toBe("too-short");
    expect((await searchGlobal(adminA(), "_")).state).toBe("too-short");
    expect((await searchGlobal(adminA(), "x".repeat(61))).state).toBe("too-long");
    expect(espiao).not.toHaveBeenCalled();
    expect(parseGlobalSearchQuery(["QA", "outro"])).toMatchObject({ kind: "ok", term: "QA" });
  });

  it("GS-DOM-11 — inativo aparece, marcado", async () => {
    const c = await cliente(fixture.companyA.id, { name: "QA GS Inativa", active: false });
    const t = await tecnico(fixture.companyA.id, "QA GS Inativa Técnica", false);
    const r = ok(await searchGlobal(adminA(), "QA GS Inativa"));
    const todos = r.groups.flatMap((g) => g.hits);
    expect(todos.find((h) => h.id === c.id)?.inactive).toBe(true);
    expect(todos.find((h) => h.id === t.id)?.inactive).toBe(true);
  });
});

describe("GS-DOM — o que sai", () => {
  it("GS-DOM-12 — DTO mínimo: sem documento, telefone, e-mail, rua, coordenada, ERP ou senha", async () => {
    await ligarRede(fixture.companyA.id);
    const c = await cliente(fixture.companyA.id, {
      name: "QA GS Privada",
      document: "98765432100",
      email: "privada@qa-gs.local",
      phone: "92911112222",
      secondaryPhone: "92933334444",
      address: "Rua Secreta",
      number: "77",
      district: "Centro",
      city: "Manaus",
      state: "AM",
      latitude: -3.1234567,
      longitude: -60.7654321,
      externalProvider: "RECEITANET",
      externalId: "ERP-555",
    });
    await ordem(fixture.companyA.id, c.id, { description: "QA GS Privada instalação" });
    await prisma.cTO.create({
      data: { companyId: fixture.companyA.id, name: "QA GS Privada CTO", capacity: 8, latitude: -3.1, longitude: -60.1 },
    });
    const r = ok(await searchGlobal(adminA(), "QA GS Privada"));
    const texto = JSON.stringify(r);
    for (const proibido of [
      "98765432100",
      "privada@qa-gs",
      "92911112222",
      "92933334444",
      "Rua Secreta",
      "-3.123",
      "-60.765",
      "ERP-555",
      "RECEITANET",
      "passwordHash",
      "storageKey",
      "latitude",
    ]) {
      expect(texto, proibido).not.toContain(proibido);
    }
    const hit = r.groups.find((g) => g.type === "CUSTOMER")!.hits[0];
    expect(Object.keys(hit).sort()).toEqual(["href", "id", "inactive", "subtitle", "title", "type"]);
    expect(hit.subtitle).toBe("Centro · Manaus/AM");
  });

  it("GS-DOM-13 — cada resultado aponta para a rota do PRÓPRIO registro", async () => {
    await ligarRede(fixture.companyA.id);
    const c = await cliente(fixture.companyA.id, { name: "QA GS Rota" });
    const os = await ordem(fixture.companyA.id, c.id, { description: "QA GS Rota da OS" });
    const t = await tecnico(fixture.companyA.id, "QA GS Rota Técnico");
    const cto = await prisma.cTO.create({ data: { companyId: fixture.companyA.id, name: "QA GS Rota CTO", capacity: 8 } });

    const r = ok(await searchGlobal(adminA(), "QA GS Rota"));
    const por = (type: GlobalSearchType, id: string) =>
      r.groups.find((g) => g.type === type)?.hits.find((h) => h.id === id)?.href;
    expect(por("CUSTOMER", c.id)).toBe(`/clientes/${c.id}/editar`);
    expect(por("SERVICE_ORDER", os.id)).toBe(`/ordens/${os.id}`);
    expect(por("CTO", cto.id)).toBe(`/ctos/${cto.id}`);
    expect(por("TECHNICIAN", t.id)).toBe("/tecnicos?search=QA%20GS%20Rota%20T%C3%A9cnico");
    // O destino do técnico é a listagem com o MESMO predicado: acha ele.
    const listagem = await listCompanyTechnicians(fixture.companyA.id, { search: "QA GS Rota Técnico" });
    expect(listagem.technicians.map((x) => x.id)).toEqual([t.id]);
  });
});

describe("GS-ERR / GS-PERF", () => {
  it("GS-ERR-01 — falha de banco vira `error`, nunca lista vazia, e o log não leva termo nem mensagem", async () => {
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("conexão caiu: SELECT * FROM customers"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await loadGlobalSearch(adminA(), "92999998888");
    expect(r).toEqual({ state: "error", term: "92999998888" });
    const registrado = JSON.stringify(log.mock.calls);
    expect(registrado).not.toContain("92999998888");
    expect(registrado).not.toContain("SELECT");
  });

  it("GS-PERF-01 — uma busca é UM lote; a CTO é uma consulta a mais só para o ADMIN com a rede", async () => {
    await ligarRede(fixture.companyA.id);
    for (let i = 0; i < 8; i += 1) {
      const c = await cliente(fixture.companyA.id, { name: `QA GS Custo ${i}` });
      await ordem(fixture.companyA.id, c.id, { description: `QA GS Custo ${i}` });
    }
    const lote = vi.spyOn(prisma, "$transaction");
    const caixas = vi.spyOn(prisma.cTO, "findMany");
    await searchGlobal(adminA(), "QA GS Custo");
    expect(lote).toHaveBeenCalledTimes(1);
    expect(caixas).toHaveBeenCalledTimes(1);
    // Cinco consultas no lote, e todas com teto.
    const consultas = lote.mock.calls[0][0] as unknown as unknown[];
    expect(consultas).toHaveLength(5);

    lote.mockClear();
    caixas.mockClear();
    await searchGlobal(despachoA(), "QA GS Custo");
    expect(lote).toHaveBeenCalledTimes(1);
    expect(caixas).not.toHaveBeenCalled();
  });
});
