import { describe, it, expect } from "vitest";
import { OPEN_SERVICE_ORDER_STATUSES } from "@/lib/service-order-labels";
import {
  NOT_STARTED_SERVICE_ORDER_STATUSES,
  SERVICE_ORDER_SLICES,
  parseServiceOrderSlice,
  serviceOrderSliceWhere,
} from "@/lib/service-order-slices";

/**
 * # Os recortes de OS do painel, fora do banco (DASH-1)
 *
 * O predicado é o contrato: o cartão e a `/ordens?recorte=…` pedem o mesmo
 * objeto a `serviceOrderSliceWhere`. Aqui se afirma a FORMA do predicado; o
 * arquivo `dashboard.test.ts` afirma o resultado contra Postgres.
 */

const RELOGIO = {
  now: new Date("2026-09-12T15:00:00.000Z"),
  timezone: "America/Sao_Paulo",
};

describe("SLICE — predicados dos recortes", () => {
  it("SLICE-01 · abertas é o predicado COMPARTILHADO, não uma lista própria", () => {
    expect(serviceOrderSliceWhere("abertas", RELOGIO)).toEqual({
      status: { in: OPEN_SERVICE_ORDER_STATUSES },
    });
  });

  it("SLICE-02 · não iniciada = aberta menos IN_PROGRESS, derivado e não listado", () => {
    expect(NOT_STARTED_SERVICE_ORDER_STATUSES).toEqual(
      OPEN_SERVICE_ORDER_STATUSES.filter((s) => s !== "IN_PROGRESS"),
    );
    expect(NOT_STARTED_SERVICE_ORDER_STATUSES).not.toContain("IN_PROGRESS");
    expect(NOT_STARTED_SERVICE_ORDER_STATUSES).not.toContain("COMPLETED");
    expect(NOT_STARTED_SERVICE_ORDER_STATUSES).not.toContain("CANCELLED");
  });

  it("SLICE-03 · atrasada: não iniciada e agendamento ANTES de agora", () => {
    expect(serviceOrderSliceWhere("atrasadas", RELOGIO)).toEqual({
      status: { in: NOT_STARTED_SERVICE_ORDER_STATUSES },
      scheduledAt: { lt: RELOGIO.now },
    });
  });

  it("SLICE-04 · hoje: aberta e agendada dentro do dia civil da EMPRESA", () => {
    expect(serviceOrderSliceWhere("hoje", RELOGIO)).toEqual({
      status: { in: OPEN_SERVICE_ORDER_STATUSES },
      scheduledAt: {
        gte: new Date("2026-09-12T03:00:00.000Z"),
        lt: new Date("2026-09-13T03:00:00.000Z"),
      },
    });
  });

  it("SLICE-05 · recorte fora da lista é null — nunca adivinhado", () => {
    for (const valido of SERVICE_ORDER_SLICES) {
      expect(parseServiceOrderSlice(valido)).toBe(valido);
    }
    for (const invalido of ["ATRASADAS", "todas", "", " hoje", undefined, null, 1, ["hoje"]]) {
      expect(parseServiceOrderSlice(invalido)).toBeNull();
    }
  });
});
