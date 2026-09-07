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

  it("`RESERVED` com cliente conectado AINDA passa — e a `CTO-2.6` tem de fechar isso", async () => {
    /*
      ## Requisito pendente, registrado onde não se perde
      ```text
      vínculo ativo + alvo RESERVED  →  409   (CTO-2.6)
      ```
      `RESERVED` significa posição separada para uso futuro, e isso não convive
      com alguém dentro.
      A verificação pertence a `setPortAdministrativeState`, DENTRO da transação
      e do `lockCto` que já existe — consultar vínculo fora do lock reabriria a
      janela que a `CTO-1.9` fechou.
      Antecipar a mudança aqui violaria a fatia congelada: a integração de
      estado é `CTO-2.6`, e este teste existe para que ela não seja esquecida.
      **Quando a `CTO-2.6` chegar, este teste deve VIRAR uma expectativa de
      recusa** — a inversão é o sinal de que a regra entrou.
    */
    const { cto, porta } = await cenarioOcupado("MARCA-R");

    await setPortAdministrativeState(
      fixture.companyA.id, fixture.adminA.id, cto.id, porta.id, "RESERVED",
    );

    const depois = await prisma.cTOPort.findUniqueOrThrow({
      where: { id: porta.id },
    });
    expect(depois.administrativeState).toBe("RESERVED");
    // O vínculo continua ativo: a combinação inválida é alcançável hoje.
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
