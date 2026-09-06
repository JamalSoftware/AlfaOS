import { describe, it, expect } from "vitest";
import { AccessProfile } from "@prisma/client";
import { navigationFor } from "@/lib/navigation";

/**
 * # Navegação por perfil e por capability
 *
 * Sem banco: `navigationFor` é uma função pura, e a regra que ela carrega —
 * item com `requires` só aparece quando a empresa tem a capability — não tinha
 * nenhuma asserção direta. Só o E2E a exercitava, indiretamente. Apontado pela
 * auditoria independente da `CTO-1`.
 *
 * Esconder o item **não é controle de segurança**: a rota responde 404 e a
 * página faz `notFound()` por conta própria. O que estes testes protegem é o
 * oposto — que ninguém veja no menu um item que leva a 404.
 */

const rotas = (profile: AccessProfile, features?: { ctoNetworkEnabled: boolean }) =>
  navigationFor(profile, features).map((i) => i.href);

describe("capability decide os itens que a exigem", () => {
  it("CTOs aparece para o ADMIN quando a empresa tem o módulo", () => {
    expect(rotas(AccessProfile.ADMIN, { ctoNetworkEnabled: true })).toContain(
      "/ctos",
    );
  });

  it("CTOs some quando a empresa não tem o módulo", () => {
    expect(
      rotas(AccessProfile.ADMIN, { ctoNetworkEnabled: false }),
    ).not.toContain("/ctos");
  });

  it("o padrão sem argumento é FECHADO", () => {
    /*
      O default importa mais do que parece: se a assinatura ganhar uma
      capability nova e algum chamador não for atualizado, o item precisa SUMIR
      do menu — não aparecer para todo mundo. Um default aberto transformaria
      "esqueci de passar" em "ofereci a todos".
    */
    expect(rotas(AccessProfile.ADMIN)).not.toContain("/ctos");
  });

  it("a capability não abre o item para quem não tem o perfil", () => {
    // Capability não é permissão: as duas regras valem juntas, e nenhuma delas
    // sozinha coloca o item na tela.
    for (const perfil of [AccessProfile.DISPATCHER, AccessProfile.TECHNICIAN]) {
      expect(rotas(perfil, { ctoNetworkEnabled: true })).not.toContain("/ctos");
    }
  });

  it("os demais itens não são afetados pela capability", () => {
    // Controle: ligar ou desligar o módulo CTO não pode mexer no resto do menu.
    const ligado = rotas(AccessProfile.ADMIN, { ctoNetworkEnabled: true });
    const desligado = rotas(AccessProfile.ADMIN, { ctoNetworkEnabled: false });
    expect(ligado.filter((h) => h !== "/ctos")).toEqual(desligado);
  });
});
