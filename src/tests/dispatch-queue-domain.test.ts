import { describe, it, expect } from "vitest";
import type { ServiceOrderPriority } from "@prisma/client";
import {
  DISPATCH_BAND,
  appendPositionForBand,
  compareByDispatchBand,
  dispatchRank,
  normalizeQueue,
  type QueueMember,
} from "@/lib/dispatch-queue";

/**
 * # Fila operacional — primitivas de domínio (DQ-1)
 *
 * Sem banco de propósito. A precedência e a normalização são as duas regras de
 * que a fila inteira depende, e regra que precisa de Postgres para ser testada
 * acaba testada de menos.
 *
 * O que estes testes protegem:
 *
 * 1. a precedência é `URGENT > HIGH > NORMAL > LOW`, e vem do MAPA — nunca da
 *    ordem de declaração do enum em Postgres;
 * 2. a normalização produz `1..N` contíguo;
 * 3. a ordenação é ESTÁVEL, que é o que faz a sequência escolhida pelo
 *    despachante sobreviver a uma renormalização;
 * 4. `I-12` (urgente precede normal) — a única invariante da capability que o
 *    banco não defende sozinho, porque `D-11` escolheu posição global.
 */

const ALL: ServiceOrderPriority[] = ["LOW", "NORMAL", "HIGH", "URGENT"];

function member(
  serviceOrderId: string,
  priority: ServiceOrderPriority,
  position: number,
): QueueMember {
  return { serviceOrderId, priority, position };
}

/** Só os ids, na ordem — é o que os testes de ordem realmente afirmam. */
function ids(members: readonly QueueMember[]): string[] {
  return members.map((m) => m.serviceOrderId);
}

describe("precedência de prioridade", () => {
  it("ordena URGENT > HIGH > NORMAL > LOW", () => {
    expect(dispatchRank("URGENT")).toBeLessThan(dispatchRank("HIGH"));
    expect(dispatchRank("HIGH")).toBeLessThan(dispatchRank("NORMAL"));
    expect(dispatchRank("NORMAL")).toBeLessThan(dispatchRank("LOW"));
  });

  it("cobre todos os pares, e não só os vizinhos", () => {
    // Vizinhos passariam mesmo com uma inversão não-transitiva. Os pares
    // saltados são os que provam que a relação é uma ordem total.
    expect(compareByDispatchBand("URGENT", "HIGH")).toBeLessThan(0);
    expect(compareByDispatchBand("URGENT", "NORMAL")).toBeLessThan(0);
    expect(compareByDispatchBand("URGENT", "LOW")).toBeLessThan(0);
    expect(compareByDispatchBand("HIGH", "NORMAL")).toBeLessThan(0);
    expect(compareByDispatchBand("HIGH", "LOW")).toBeLessThan(0);
    expect(compareByDispatchBand("NORMAL", "LOW")).toBeLessThan(0);

    // E o sentido inverso, para que trocar dois valores no mapa não passe
    // despercebido por um teste que só olha um lado.
    expect(compareByDispatchBand("HIGH", "URGENT")).toBeGreaterThan(0);
    expect(compareByDispatchBand("NORMAL", "URGENT")).toBeGreaterThan(0);
    expect(compareByDispatchBand("LOW", "URGENT")).toBeGreaterThan(0);
    expect(compareByDispatchBand("NORMAL", "HIGH")).toBeGreaterThan(0);
    expect(compareByDispatchBand("LOW", "HIGH")).toBeGreaterThan(0);
    expect(compareByDispatchBand("LOW", "NORMAL")).toBeGreaterThan(0);
  });

  it("considera iguais duas prioridades iguais", () => {
    for (const p of ALL) {
      expect(compareByDispatchBand(p, p)).toBe(0);
    }
  });

  it("ordena uma lista embaralhada", () => {
    const embaralhado: ServiceOrderPriority[] = [
      "LOW",
      "URGENT",
      "NORMAL",
      "HIGH",
    ];
    expect([...embaralhado].sort(compareByDispatchBand)).toEqual([
      "URGENT",
      "HIGH",
      "NORMAL",
      "LOW",
    ]);
  });

  it("dá uma banda distinta a cada prioridade", () => {
    // Duas prioridades com a mesma banda destruiriam a ordenação sem quebrar
    // nenhum dos testes de par acima.
    expect(new Set(Object.values(DISPATCH_BAND)).size).toBe(ALL.length);
  });

  it("NÃO deriva a precedência da ordem de declaração do enum", () => {
    /*
      O enum está declarado `LOW, NORMAL, HIGH, URGENT` — ordem CRESCENTE de
      urgência. O mapa é DECRESCENTE (`URGENT: 0`). São orientações opostas de
      propósito, e é isso que este teste trava.

      Se um dia alguém "simplificar" `DISPATCH_BAND` derivando-o da posição do
      valor no enum, a orientação se inverte e a fila passa a atender as OS de
      baixa prioridade primeiro. Aqui isso falha na hora.
    */
    const ordemDeDeclaracao: ServiceOrderPriority[] = [
      "LOW",
      "NORMAL",
      "HIGH",
      "URGENT",
    ];
    const porDeclaracao = ordemDeDeclaracao.map((p) =>
      ordemDeDeclaracao.indexOf(p),
    );
    const porDominio = ordemDeDeclaracao.map((p) => dispatchRank(p));

    expect(porDominio).not.toEqual(porDeclaracao);
    expect(porDominio).toEqual([3, 2, 1, 0]);
  });
});

describe("normalização da fila", () => {
  it("produz posições 1..N contíguas", () => {
    const fila = [
      member("a", "NORMAL", 4),
      member("b", "NORMAL", 9),
      member("c", "NORMAL", 17),
    ];
    expect(normalizeQueue(fila).map((m) => m.position)).toEqual([1, 2, 3]);
  });

  it("põe as urgentes à frente das normais", () => {
    const fila = [
      member("normal-1", "NORMAL", 1),
      member("urgente-1", "URGENT", 2),
      member("baixa-1", "LOW", 3),
      member("alta-1", "HIGH", 4),
    ];
    expect(ids(normalizeQueue(fila))).toEqual([
      "urgente-1",
      "alta-1",
      "normal-1",
      "baixa-1",
    ]);
  });

  it("PRESERVA a ordem escolhida pelo despachante dentro da banda", () => {
    /*
      O teste que sustenta a ordenação estável. Sem ela, renormalizar
      embaralharia as urgentes entre si a cada leitura — e a sequência que o
      despachante montou é exatamente o produto desta capability.
    */
    const fila = [
      member("u3", "URGENT", 1),
      member("u1", "URGENT", 2),
      member("u2", "URGENT", 3),
    ];
    expect(ids(normalizeQueue(fila))).toEqual(["u3", "u1", "u2"]);
  });

  it("não muda nada quando a fila já está normalizada", () => {
    const fila = [
      member("u", "URGENT", 1),
      member("n", "NORMAL", 2),
      member("l", "LOW", 3),
    ];
    expect(normalizeQueue(fila)).toEqual(fila);
  });

  it("não muta a lista de entrada", () => {
    const fila = [member("a", "NORMAL", 7), member("b", "URGENT", 2)];
    const copia = structuredClone(fila);
    normalizeQueue(fila);
    expect(fila).toEqual(copia);
  });

  it("aceita fila vazia", () => {
    expect(normalizeQueue([])).toEqual([]);
  });
});

describe("normalização com intenção", () => {
  const base = () => [
    member("n1", "NORMAL", 1),
    member("n2", "NORMAL", 2),
    member("n3", "NORMAL", 3),
    member("n4", "NORMAL", 4),
  ];

  it("move para a posição pedida", () => {
    const out = normalizeQueue(base(), {
      serviceOrderId: "n4",
      targetPosition: 1,
    });
    expect(ids(out)).toEqual(["n4", "n1", "n2", "n3"]);
    expect(out.map((m) => m.position)).toEqual([1, 2, 3, 4]);
  });

  it("move para o meio", () => {
    expect(
      ids(normalizeQueue(base(), { serviceOrderId: "n1", targetPosition: 3 })),
    ).toEqual(["n2", "n3", "n1", "n4"]);
  });

  it("é IDEMPOTENTE: o mesmo alvo aplicado duas vezes dá o mesmo estado", () => {
    /*
      A razão de o contrato ser alvo absoluto e não delta (PRD §318). "Subir
      uma posição" aplicada duas vezes sobe DUAS — retry de rede e duplo
      clique transformariam uma correção em duas.
    */
    const intent = { serviceOrderId: "n4", targetPosition: 2 };
    const uma = normalizeQueue(base(), intent);
    const duas = normalizeQueue(uma, intent);
    expect(duas).toEqual(uma);
  });

  it("sofre clamp acima do tamanho da fila, em vez de erro", () => {
    expect(
      ids(normalizeQueue(base(), { serviceOrderId: "n1", targetPosition: 99 })),
    ).toEqual(["n2", "n3", "n4", "n1"]);
  });

  it("sofre clamp em zero e em negativo", () => {
    for (const alvo of [0, -5]) {
      expect(
        ids(normalizeQueue(base(), { serviceOrderId: "n3", targetPosition: alvo })),
      ).toEqual(["n3", "n1", "n2", "n4"]);
    }
  });

  it("ignora intenção sobre OS que não está na fila", () => {
    // A OS pode ter sido concluída entre a leitura da tela e o comando. O CAS
    // da fila recusa o caso em que isso importa; aqui não é erro.
    const out = normalizeQueue(base(), {
      serviceOrderId: "fantasma",
      targetPosition: 1,
    });
    expect(ids(out)).toEqual(["n1", "n2", "n3", "n4"]);
  });

  it("I-12: uma NORMAL com alvo 1 NÃO ultrapassa as urgentes", () => {
    /*
      A invariante que `D-11` tirou do banco. Com posição global, nada no
      Postgres impede uma NORMAL na posição 1 — só este passo impede.

      E note o desfecho: a operação é ACOMODADA, não recusada. A OS vai para o
      topo da banda dela. Recusar faria o cartão voltar sozinho na tela, que é
      lido como travamento (PRD §204).
    */
    const fila = [
      member("u1", "URGENT", 1),
      member("u2", "URGENT", 2),
      member("n1", "NORMAL", 3),
      member("n2", "NORMAL", 4),
    ];
    const out = normalizeQueue(fila, {
      serviceOrderId: "n2",
      targetPosition: 1,
    });

    expect(ids(out)).toEqual(["u1", "u2", "n2", "n1"]);
    // A afirmação que importa, escrita como invariante e não como exemplo:
    const primeiraNormal = out.findIndex((m) => m.priority === "NORMAL");
    const ultimaUrgente = out.map((m) => m.priority).lastIndexOf("URGENT");
    expect(primeiraNormal).toBeGreaterThan(ultimaUrgente);
  });

  it("I-12 vale para qualquer permutação de alvo", () => {
    const fila = [
      member("u1", "URGENT", 1),
      member("h1", "HIGH", 2),
      member("n1", "NORMAL", 3),
      member("l1", "LOW", 4),
    ];

    for (const alvo of [1, 2, 3, 4]) {
      for (const id of ["u1", "h1", "n1", "l1"]) {
        const out = normalizeQueue(fila, {
          serviceOrderId: id,
          targetPosition: alvo,
        });
        const bandas = out.map((m) => dispatchRank(m.priority));
        // Nunca decrescente: nenhuma OS de banda mais fraca fica na frente.
        expect([...bandas].sort((a, b) => a - b)).toEqual(bandas);
        expect(out.map((m) => m.position)).toEqual([1, 2, 3, 4]);
      }
    }
  });
});

describe("posição de entrada de uma OS nova", () => {
  const fila = [
    member("u1", "URGENT", 1),
    member("h1", "HIGH", 2),
    member("n1", "NORMAL", 3),
    member("n2", "NORMAL", 4),
  ];

  it("entra no fim da própria banda", () => {
    expect(appendPositionForBand(fila, "URGENT")).toBe(2);
    expect(appendPositionForBand(fila, "HIGH")).toBe(3);
    expect(appendPositionForBand(fila, "NORMAL")).toBe(5);
    expect(appendPositionForBand(fila, "LOW")).toBe(5);
  });

  it("uma URGENT nova NÃO ultrapassa as urgentes já ordenadas", () => {
    // Chegar depois não é ser mais importante (PRD §317).
    const out = normalizeQueue(
      [...fila, member("nova", "URGENT", 99)],
      {
        serviceOrderId: "nova",
        targetPosition: appendPositionForBand(fila, "URGENT"),
      },
    );
    expect(ids(out)).toEqual(["u1", "nova", "h1", "n1", "n2"]);
  });

  it("na fila vazia, entra na posição 1", () => {
    for (const p of ALL) {
      expect(appendPositionForBand([], p)).toBe(1);
    }
  });
});
