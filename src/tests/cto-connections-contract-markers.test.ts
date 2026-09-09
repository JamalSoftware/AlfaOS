import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { connectCustomerToPort, type ConnectionContext } from "@/lib/cto-connections";
import {
  createCto,
  effectivePortState,
  getCto,
  setPortAdministrativeState,
} from "@/lib/cto";
import { seedTestData, type TestFixture } from "./helpers";

/**
 * # Marcadores de contrato — o que as fases seguintes NÃO podem esquecer
 *
 * Estes testes não protegem a `CTO-2.1`: protegem duas obrigações que nasceram
 * do congelamento e que vencem em fases posteriores. Eles fixam o estado ATUAL
 * e dizem, no lugar onde alguém vai olhar, o que precisa mudar e por quê.
 *
 * Um requisito registrado só em documento se perde. Um teste que falha desde já
 * seria pior — vira ruído que a próxima pessoa desabilita. Estes afirmam a
 * verdade de hoje e falham no dia em que o comportamento mudar, forçando quem
 * mudou a ler a justificativa e atualizar o marcador de propósito.
 */

let fixture: TestFixture;
let ctx: ConnectionContext;

beforeEach(async () => {
  fixture = await seedTestData();
  await prisma.company.update({
    where: { id: fixture.companyA.id },
    data: { ctoNetworkEnabled: true },
  });
  ctx = {
    companyId: fixture.companyA.id,
    provenance: { source: "WEB", actorUserId: fixture.adminA.id },
  };
});

async function cenarioOcupado(nome: string) {
  const cto = await createCto(fixture.companyA.id, fixture.adminA.id, {
    name: nome,
    capacity: 8,
  });
  const porta = await prisma.cTOPort.findFirstOrThrow({
    where: { ctoId: cto.id, number: 1 },
  });
  const cliente = await prisma.customer.create({
    data: { companyId: fixture.companyA.id, name: "Ocupante" },
  });
  await connectCustomerToPort(ctx, {
    customerId: cliente.id,
    ctoPortId: porta.id,
  });
  return { cto, porta };
}

// ---------------------------------------------------------------------------

describe("MARCADOR `CTO-2.6` · vínculo ativo × estado administrativo", () => {
  it("`DAMAGED` e `AVAILABLE` são permitidos com cliente conectado — e precisam continuar sendo", async () => {
    /*
      Metade da regra da Opção B já é verdade e precisa PERMANECER verdade.

      É a metade que a simplificação erraria: "porta ocupada não muda de estado"
      seria a regra fácil de escrever e criaria um beco sem saída — uma porta
      consertada não poderia voltar a `AVAILABLE` sem desconectar o cliente.
    */
    const { cto, porta } = await cenarioOcupado("MARCA-A");

    await setPortAdministrativeState(
      fixture.companyA.id, fixture.adminA.id, cto.id, porta.id, "DAMAGED",
    );
    expect(
      (await prisma.cTOPort.findUniqueOrThrow({ where: { id: porta.id } }))
        .administrativeState,
    ).toBe("DAMAGED");

    // E a volta, que é o ponto do beco sem saída.
    await setPortAdministrativeState(
      fixture.companyA.id, fixture.adminA.id, cto.id, porta.id, "AVAILABLE",
    );
    expect(
      (await prisma.cTOPort.findUniqueOrThrow({ where: { id: porta.id } }))
        .administrativeState,
    ).toBe("AVAILABLE");
  });

  it("`RESERVED` com cliente conectado é RECUSADO — a `CTO-2.6` fechou isto", async () => {
    /*
      ## O marcador venceu, e virou o que ele mesmo pediu
      ```text
      vínculo ativo + alvo RESERVED  →  409
      ```
      Até a `CTO-2.6` este teste afirmava o contrário — que a combinação era
      alcançável — e trazia escrito: *"quando a `CTO-2.6` chegar, este teste
      deve VIRAR uma expectativa de recusa; a inversão é o sinal de que a regra
      entrou"*. É essa inversão.

      `RESERVED` significa posição separada para uso futuro, e isso não convive
      com alguém dentro. A verificação vive em `setPortAdministrativeState`,
      DENTRO da transação e do `lockCto` que já existia — fora do lock, ela
      reabriria a janela que a `CTO-1.9` fechou.

      O teste acima continua sendo a outra metade da regra, e as duas se leem
      juntas: o que a `CTO-2.6` proibiu foi o **alvo** `RESERVED`, nunca toda
      mutação sobre porta ocupada.
    */
    const { cto, porta } = await cenarioOcupado("MARCA-R");

    await expect(
      setPortAdministrativeState(
        fixture.companyA.id, fixture.adminA.id, cto.id, porta.id, "RESERVED",
      ),
    ).rejects.toMatchObject({ status: 409 });

    const depois = await prisma.cTOPort.findUniqueOrThrow({
      where: { id: porta.id },
    });
    expect(depois.administrativeState).toBe("AVAILABLE");
    // E o cliente continua exatamente onde estava: recusar não desconecta.
    expect(
      await prisma.customerNetworkConnection.count({
        where: { ctoPortId: porta.id, disconnectedAt: null },
      }),
    ).toBe(1);
  });
});

describe("MARCADOR `CTO-2.2` · as duas dimensões não podem colapsar", () => {
  it("`effectivePortState` é LOSSY: `DAMAGED` some quando a porta está ocupada", async () => {
    /*
      ## O defeito que a Opção B tornou alcançável
      `effectivePortState` devolve `OCCUPIED` sempre que há vínculo, e o resumo
      da CTO conta `damaged` a partir dele. Uma porta fisicamente quebrada COM
      cliente dentro sai da contagem de danificadas.
      A precedência publicada não está errada — `OCCUPIED` vence como RÓTULO, de
      propósito. Errado é DERIVAR contagem dela.
      ```text
      damaged  ← administrativeState = DAMAGED     (ocupada ou não)
      occupied ← existe vínculo ativo
      ```
      As categorias passam a se sobrepor, e a soma deixa de ser `capacity`.
      Uma tela que as apresente como fatias de um todo estará errada.
      **Obrigação da `CTO-2.2`.** Este teste fixa o comportamento atual; quando
      o resumo passar a contar por `administrativeState`, ele deve ser
      atualizado junto — e a atualização é o sinal de que a correção entrou.
    */
    expect(effectivePortState("DAMAGED", true)).toBe("OCCUPIED");
    expect(effectivePortState("DAMAGED", false)).toBe("DAMAGED");

    const { cto, porta } = await cenarioOcupado("MARCA-D");
    await setPortAdministrativeState(
      fixture.companyA.id, fixture.adminA.id, cto.id, porta.id, "DAMAGED",
    );

    // A coluna guarda a verdade...
    expect(
      (await prisma.cTOPort.findUniqueOrThrow({ where: { id: porta.id } }))
        .administrativeState,
    ).toBe("DAMAGED");

    // ...e o resumo de HOJE não a enxerga, porque a ocupação ainda é sempre 0
    // no read model da CTO-1 (não há consulta de vínculo nele).
    const detalhe = await getCto(fixture.companyA.id, cto.id);
    expect(detalhe!.summary.damaged).toBe(1);
    expect(detalhe!.summary.occupied).toBe(0);

    /*
      Hoje a contagem acerta por um motivo ERRADO: o read model da `CTO-1` não
      consulta vínculo, então `hasActiveConnection` é sempre `false` e o rótulo
      nunca colapsa. No instante em que a `CTO-2.2` ligar a ocupação real ao
      read model — que é o trabalho dela —, `damaged` cairá para 0 se a contagem
      continuar derivando de `effectiveState`. É exatamente esse passo que este
      marcador existe para tornar visível.
    */
  });
});
