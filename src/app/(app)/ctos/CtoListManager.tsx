"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CtoMapStatus } from "@/lib/cto-map";
import { ctoMapStatusPresentation } from "@/lib/cto-map-presentation";

interface CtoRow {
  id: string;
  name: string;
  code: string | null;
  capacity: number;
  active: boolean;
  addressReference: string | null;
}

/**
 * O recorte do painel que abriu a lista, com a razão de cada caixa estar nele
 * (DASH-1a). O estado chega pronto do servidor — a mesma leitura que contou o
 * cartão —, e a tela só o traduz com a tabela de apresentação do mapa: ela não
 * recalcula precedência nenhuma.
 */
export interface CtoSliceContext {
  filter: "defeito" | "com-os-abertas";
  byCto: Record<
    string,
    { status: CtoMapStatus; damagedPortCount: number; openServiceOrderCount: number }
  >;
}

const STATUS_BADGE_CLASS = {
  danger: "border-danger-border bg-danger-bg text-danger-fg",
  warning: "border-warning-border bg-warning-bg text-warning-fg",
  success: "border-success-border bg-success-bg text-success-fg",
  neutral: "border-border bg-surface-muted text-fg-secondary",
} as const;

const inputClass =
  "w-full rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft";

const labelClass = "mb-1 block text-sm font-medium text-fg-secondary";

export function CtoListManager({
  ctos,
  slice = null,
}: {
  ctos: CtoRow[];
  slice?: CtoSliceContext | null;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [capacity, setCapacity] = useState("8");
  const [addressReference, setAddressReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Informe o nome da CTO.");
      return;
    }
    const parsedCapacity = Number(capacity);
    if (
      !Number.isInteger(parsedCapacity) ||
      parsedCapacity < 1 ||
      parsedCapacity > 256
    ) {
      setError("A capacidade deve ser um número inteiro entre 1 e 256 portas.");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/ctos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          // Vazio vira `null`: string em branco não é um código, e gravá-la
          // faria "sem código" e "código vazio" virarem estados diferentes.
          code: code.trim() ? code.trim() : null,
          capacity: parsedCapacity,
          addressReference: addressReference.trim()
            ? addressReference.trim()
            : null,
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(payload?.error ?? "Falha ao cadastrar a CTO.");
        return;
      }
      setName("");
      setCode("");
      setCapacity("8");
      setAddressReference("");
      router.refresh();
    } catch {
      setError("Erro de conexão. Tente novamente.");
    } finally {
      setCreating(false);
    }
  }

  const createForm = (
    <form
      onSubmit={handleCreate}
      className="rounded-2xl border border-border bg-surface p-5 shadow-sm"
      data-testid="cto-create-form"
    >
      <h2 className="mb-4 text-base font-semibold text-fg">Nova CTO</h2>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="cto-name">
            Nome
          </label>
          <input
            id="cto-name"
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ex.: A16"
            maxLength={60}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="cto-code">
            Código (opcional)
          </label>
          <input
            id="cto-code"
            className={inputClass}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            maxLength={40}
          />
          <p className="mt-1 text-xs text-fg-muted">
            Não pode ser alterado depois de cadastrado.
          </p>
        </div>
        <div>
          <label className={labelClass} htmlFor="cto-capacity">
            Capacidade (portas)
          </label>
          <input
            id="cto-capacity"
            type="number"
            min={1}
            max={256}
            className={inputClass}
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
          />
          <p className="mt-1 text-xs text-fg-muted">
            As portas são criadas automaticamente, numeradas de 1 até a
            capacidade.
          </p>
        </div>
        <div>
          <label className={labelClass} htmlFor="cto-address">
            Referência de endereço (opcional)
          </label>
          <input
            id="cto-address"
            className={inputClass}
            value={addressReference}
            onChange={(e) => setAddressReference(e.target.value)}
            placeholder="ex.: Poste em frente ao nº 340"
            maxLength={200}
          />
        </div>
      </div>

      {error && (
        <p className="mt-4 text-sm text-danger-fg" role="alert">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={creating}
        className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-fg transition-colors hover:bg-primary-hover disabled:opacity-60"
      >
        {creating ? "Cadastrando..." : "Cadastrar CTO"}
      </button>
    </form>
  );

  const results = ctos.length > 0 && (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-surface-muted">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-fg-secondary">
                Nome
              </th>
              {slice?.filter === "defeito" && (
                <>
                  <th className="px-4 py-3 text-left font-medium text-fg-secondary">
                    Estado operacional
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-fg-secondary">
                    Portas danificadas
                  </th>
                </>
              )}
              {slice?.filter === "com-os-abertas" && (
                <th className="px-4 py-3 text-left font-medium text-fg-secondary">
                  OS abertas
                </th>
              )}
              <th className="px-4 py-3 text-left font-medium text-fg-secondary">
                Código
              </th>
              <th className="px-4 py-3 text-left font-medium text-fg-secondary">
                Capacidade
              </th>
              <th className="px-4 py-3 text-left font-medium text-fg-secondary">
                Referência
              </th>
              <th className="px-4 py-3 text-left font-medium text-fg-secondary">
                {slice ? "Status cadastral" : "Situação"}
              </th>
            </tr>
          </thead>
          <tbody>
            {ctos.map((cto) => (
              <tr
                key={cto.id}
                className="border-b border-border last:border-0"
                data-testid="cto-row"
              >
                <td className="px-4 py-3">
                  <Link
                    href={`/ctos/${cto.id}`}
                    className="font-medium text-primary-text hover:underline"
                  >
                    {cto.name}
                  </Link>
                </td>
                {slice && <SliceCells filter={slice.filter} context={slice.byCto[cto.id]} />}
                <td className="px-4 py-3 text-fg-secondary">
                  {cto.code ?? "—"}
                </td>
                <td className="px-4 py-3 text-fg-secondary">
                  {cto.capacity} {cto.capacity === 1 ? "porta" : "portas"}
                </td>
                <td className="px-4 py-3 text-fg-secondary">
                  {cto.addressReference ?? "—"}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={
                      cto.active
                        ? "rounded-full bg-success-bg px-2 py-0.5 text-xs font-medium text-success-fg"
                        : "rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium text-fg-muted"
                    }
                  >
                    {cto.active ? "Ativa" : "Inativa"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  /*
    Sem recorte, a tela é de cadastro: o formulário vem primeiro, como sempre.
    Com recorte, a pessoa veio do painel para VER caixas que pedem atenção — o
    resultado vem primeiro e o formulário desce, sem sumir (DASH-1a).
  */
  return (
    <div className="space-y-6">
      {slice ? (
        <>
          {results}
          {createForm}
        </>
      ) : (
        <>
          {createForm}
          {results}
        </>
      )}
    </div>
  );
}

function SliceCells({
  filter,
  context,
}: {
  filter: CtoSliceContext["filter"];
  context: CtoSliceContext["byCto"][string] | undefined;
}) {
  if (filter === "com-os-abertas") {
    return (
      <td className="px-4 py-3 font-semibold tabular-nums text-fg" data-testid="cto-open-orders">
        {context?.openServiceOrderCount ?? "—"}
      </td>
    );
  }
  const apresentacao = context ? ctoMapStatusPresentation(context.status) : null;
  return (
    <>
      <td className="px-4 py-3" data-testid="cto-operational-state">
        {apresentacao ? (
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE_CLASS[apresentacao.tone]}`}
          >
            <span aria-hidden="true">{apresentacao.glyph}</span>
            {apresentacao.label}
          </span>
        ) : (
          "—"
        )}
      </td>
      <td className="px-4 py-3 font-semibold tabular-nums text-fg" data-testid="cto-damaged-ports">
        {context?.damagedPortCount ?? "—"}
      </td>
    </>
  );
}
