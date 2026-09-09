import { beforeEach, describe, expect, it } from "vitest";
import { createCto } from "@/lib/cto";
import {
  connectCustomerToPort,
  type ConnectionContext,
} from "@/lib/cto-connections";
import { getCustomerNetworkView } from "@/lib/cto-read-model";
import { prisma } from "@/lib/prisma";
import { completeServiceOrder } from "@/lib/service-order-closing";
import {
  startServiceOrder,
  updateServiceOrderExecution,
} from "@/lib/service-orders";
import {
  allocateTestServiceOrderNumber,
  seedTestData,
  type TestFixture,
} from "./helpers";

/**
 * # `CTO-2.7` — o vínculo NÃO pertence ao ciclo de vida da OS
 *
 * O vínculo pode **nascer** durante um atendimento, e é isso que confunde:
 * concluir a OS parece "fechar o assunto". Não fecha. O cliente continua na
 * porta depois que o técnico vai embora, e é justamente essa permanência que a
 * capability existe para registrar.
 *
 * A independência é hoje **estrutural**: só `cto-connections.ts` escreve na
 * tabela, não existe `delete` em produção, e a FK da OS é `SetNull` — apagar a
 * ordem nem alcançaria a linha. O que faltava era um teste dizendo isso, para
 * que um `completeServiceOrder` futuro que resolva "limpar" caia aqui em vez de
 * numa auditoria.
 *
 * Lacuna encontrada no inventário de critérios da `CTO-2.7`. As fixturas são
 * fictícias.
 */

let fixture: TestFixture;

beforeEach(async () => {
  fixture = await seedTestData();
  await prisma.company.update({
    where: { id: fixture.companyA.id },
    data: { ctoNetworkEnabled: true },
  });
});

interface Cenario {
  orderId: string;
  customerId: string;
  technicianId: string;
  orderVersion: number;
  executionVersion: number;
}

/** OS real do técnico A, em andamento, pela máquina de estados. */
async function cenario(): Promise<Cenario> {
  const technician = await prisma.technician.upsert({
    where: { userId: fixture.techA.id },
    update: {},
    create: { companyId: fixture.companyA.id, userId: fixture.techA.id },
    select: { id: true },
  });
  const customer = await prisma.customer.create({
    data: { companyId: fixture.companyA.id, name: "Cliente Ficticio" },
  });
  const order = await prisma.serviceOrder.create({
    data: {
      companyId: fixture.companyA.id,
      number: await allocateTestServiceOrderNumber(fixture.companyA.id),
      customerId: customer.id,
      technicianId: technician.id,
      type: "Instalação",
      description: "Instalação de fibra (fixture).",
      status: "ASSIGNED",
      assignedAt: new Date(),
    },
  });

  const started = await startServiceOrder(
    fixture.companyA.id,
    fixture.techA.id,
    order.id,
    order.version,
  );
  // A política de conclusão exige o relatório preenchido; sem isto o teste
  // pararia numa recusa que não tem nada a ver com o que ele quer provar.
  const execucao = await updateServiceOrderExecution(
    fixture.companyA.id,
    fixture.techA.id,
    order.id,
    started.execution.version,
    {
      diagnosis: "Atenuação alta no conector.",
      workPerformed: "Conector refeito e testado.",
    },
  );
  const atual = await prisma.serviceOrder.findUniqueOrThrow({
    where: { id: order.id },
    select: { version: true },
  });

  return {
    orderId: order.id,
    customerId: customer.id,
    technicianId: technician.id,
    orderVersion: atual.version,
    executionVersion: execucao.version,
  };
}

async function portaLivre(nome: string, numero: number) {
  const cto = await createCto(fixture.companyA.id, fixture.adminA.id, {
    name: nome,
    capacity: 8,
  });
  const port = await prisma.cTOPort.findFirstOrThrow({
    where: { ctoId: cto.id, number: numero },
  });
  return { cto, port };
}

describe("CTO-2.7 · o vínculo sobrevive à OS", () => {
  it("LIFE-01 concluir a OS NÃO encerra o vínculo criado nela", async () => {
    const c = await cenario();
    const { cto, port } = await portaLivre("CX-LIFE-01", 4);
    const ctx: ConnectionContext = {
      companyId: fixture.companyA.id,
      provenance: {
        source: "FIELD",
        actorUserId: fixture.techA.id,
        technicianId: c.technicianId,
        serviceOrderId: c.orderId,
      },
    };
    const vinculo = await connectCustomerToPort(ctx, {
      customerId: c.customerId,
      ctoPortId: port.id,
    });

    const versaoAntes = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: c.orderId },
      select: { version: true },
    });
    await completeServiceOrder(
      fixture.companyA.id,
      fixture.techA.id,
      c.orderId,
      {
        expectedOrderVersion: versaoAntes.version,
        expectedExecutionVersion: c.executionVersion,
      },
    );

    // A OS fechou.
    expect(
      (
        await prisma.serviceOrder.findUniqueOrThrow({
          where: { id: c.orderId },
          select: { status: true },
        })
      ).status,
    ).toBe("COMPLETED");

    // O cliente continua na porta — que é o ponto inteiro da capability.
    const linha = await prisma.customerNetworkConnection.findUniqueOrThrow({
      where: { id: vinculo.id },
    });
    expect(linha.disconnectedAt).toBeNull();
    expect(linha.ctoPortId).toBe(port.id);
    // A procedência também sobrevive: é ela que responde "por qual OS?".
    expect(linha.serviceOrderId).toBe(c.orderId);
    expect(linha.technicianId).toBe(c.technicianId);

    const visao = await getCustomerNetworkView(
      fixture.companyA.id,
      c.customerId,
    );
    expect(visao.current).not.toBeNull();
    expect(visao.current!.cto.id).toBe(cto.id);
  });

  it("LIFE-02 a conclusão não toca NENHUMA linha de vínculo da empresa", async () => {
    const c = await cenario();
    const { port } = await portaLivre("CX-LIFE-02", 4);
    const ctx: ConnectionContext = {
      companyId: fixture.companyA.id,
      provenance: {
        source: "FIELD",
        actorUserId: fixture.techA.id,
        technicianId: c.technicianId,
        serviceOrderId: c.orderId,
      },
    };
    await connectCustomerToPort(ctx, {
      customerId: c.customerId,
      ctoPortId: port.id,
    });

    // Uma segunda linha, de OUTRO cliente e sem OS nenhuma: se a conclusão
    // decidisse "limpar", ela apareceria aqui também.
    const outro = await prisma.customer.create({
      data: { companyId: fixture.companyA.id, name: "Cliente Sem OS" },
    });
    const { port: outraPorta } = await portaLivre("CX-LIFE-02-B", 1);
    await connectCustomerToPort(
      {
        companyId: fixture.companyA.id,
        provenance: { source: "WEB", actorUserId: fixture.adminA.id },
      },
      { customerId: outro.id, ctoPortId: outraPorta.id },
    );

    const antes = await prisma.customerNetworkConnection.findMany({
      where: { companyId: fixture.companyA.id },
      orderBy: { id: "asc" },
    });

    const versaoAntes = await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: c.orderId },
      select: { version: true },
    });
    await completeServiceOrder(
      fixture.companyA.id,
      fixture.techA.id,
      c.orderId,
      {
        expectedOrderVersion: versaoAntes.version,
        expectedExecutionVersion: c.executionVersion,
      },
    );

    /*
      Igualdade profunda sobre TODAS as linhas, e não uma amostra.

      Conferir só a que a OS criou deixaria passar exatamente o defeito que
      preocupa: uma limpeza escrita por empresa em vez de por vínculo.
    */
    expect(
      await prisma.customerNetworkConnection.findMany({
        where: { companyId: fixture.companyA.id },
        orderBy: { id: "asc" },
      }),
    ).toEqual(antes);
  });

  it("LIFE-03 o vínculo não pode ser apagado por caminho nenhum de produção", async () => {
    /*
      Prova sobre o FONTE, e não sobre um comportamento.

      A independência acima vale para o caminho que existe hoje; esta afirmação
      vale para os que alguém escrever depois. Nenhum arquivo de produção
      apaga vínculo — só `cto-connections.ts` escreve, e só com `create` e
      `update`.
    */
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");

    const arquivos: string[] = [];
    const varrer = (dir: string) => {
      for (const nome of readdirSync(dir)) {
        const caminho = join(dir, nome);
        if (statSync(caminho).isDirectory()) varrer(caminho);
        else if (caminho.endsWith(".ts") || caminho.endsWith(".tsx")) {
          arquivos.push(caminho);
        }
      }
    };
    varrer("src/lib");
    varrer("src/app");

    const escritores = new Set<string>();
    for (const caminho of arquivos) {
      const fonte = readFileSync(caminho, "utf8");
      if (/customerNetworkConnection\s*\.\s*delete/.test(fonte)) {
        throw new Error(`${caminho} apaga vínculo de rede`);
      }
      if (/customerNetworkConnection\s*\.\s*(create|update|upsert)/.test(fonte)) {
        escritores.add(caminho.replace(/\\/g, "/"));
      }
    }

    // Um único escritor, e ele é o domínio.
    expect(Array.from(escritores)).toEqual(["src/lib/cto-connections.ts"]);
  });
});
