"use client";

import { useState } from "react";
import { formatBrazilianPhone } from "@/integrations/service-tickets";

/**
 * Contexto operacional do cliente no ReceitaNet — somente leitura.
 *
 * Carregado sob demanda, nunca no render inicial: a página da OS não pode ficar
 * refém da latência do provider, e um ERP lento não deve atrasar o que o
 * despachante já tem em mãos.
 *
 * Só ADMIN e DISPATCHER veem este bloco, e a rota também recusa TECHNICIAN —
 * a UI não é o controle, é a consequência dele.
 */

interface Ticket {
  externalId: string;
  externalNumber: string | null;
  protocol: string | null;
  description: string | null;
  typeCode: string | null;
  forecast: string | null;
  contactPhone: string | null;
}

interface ErpContext {
  linked: boolean;
  provider: string | null;
  contract: {
    status: string | null;
    plan: string | null;
    technologyCode: string | null;
    serverMaintenance: boolean | null;
    error: string | null;
  };
  tickets: { items: Ticket[]; cap: number | null; error: string | null };
  fetchedAt: string;
}

/** Mensagens por código. O corpo nunca traz texto do provider para a tela. */
const ERROR_LABEL: Record<string, string> = {
  AUTHENTICATION_FAILED: "Credencial do ReceitaNet recusada.",
  UPSTREAM_UNAVAILABLE: "O ReceitaNet não respondeu.",
  RATE_LIMITED: "Consultas demais em pouco tempo.",
  TIMEOUT: "A consulta excedeu o tempo limite.",
  INVALID_RESPONSE: "O ReceitaNet respondeu em formato inesperado.",
  CUSTOMER_NOT_FOUND: "Cliente não localizado no ReceitaNet.",
  NOT_SUPPORTED: "Consulta não disponível para este provedor.",
};

function errorText(code: string | null): string | null {
  if (!code) return null;
  return ERROR_LABEL[code] ?? "Não foi possível consultar o ReceitaNet.";
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{value}</dd>
    </div>
  );
}

export function ReceitanetContextPanel({ orderId }: { orderId: string }) {
  const [context, setContext] = useState<ErpContext | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    // O resultado anterior sai da tela ao começar: dado velho sob um clique
    // novo é lido como resposta nova.
    setContext(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/service-orders/${orderId}/receitanet-context`, {
        // A consulta é sempre ao vivo — cache aqui mostraria contrato de ontem.
        cache: "no-store",
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(payload?.error ?? "Falha ao consultar o ReceitaNet.");
        return;
      }
      setContext(payload?.data?.context ?? null);
    } catch {
      setError("Erro de conexão. Tente novamente.");
    } finally {
      setBusy(false);
    }
  }

  const contractError = errorText(context?.contract.error ?? null);
  const ticketsError = errorText(context?.tickets.error ?? null);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900">ReceitaNet</h2>
        <button
          type="button"
          data-testid="load-receitanet-context"
          disabled={busy}
          onClick={load}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "Consultando..." : context ? "Atualizar" : "Consultar"}
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      )}

      {context && !context.linked && (
        <p className="mt-3 text-sm text-slate-500">
          Este cliente não está vinculado a um provedor externo.
        </p>
      )}

      {context?.linked && (
        <div className="mt-3 space-y-4">
          <div>
            {contractError ? (
              <p className="text-sm text-amber-700">{contractError}</p>
            ) : (
              <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Contrato" value={context.contract.status ?? "Não informado"} />
                <Field label="Plano" value={context.contract.plan ?? "Não informado"} />
                {/*
                  Tecnologia fica como CÓDIGO. O contrato declara um inteiro e
                  não publica o significado dos valores — escrever "Fibra" aqui
                  produziria uma tela que parece informada e mente.
                */}
                <Field
                  label="Tecnologia (código)"
                  value={context.contract.technologyCode ?? "Não informado"}
                />
                <Field
                  label="Servidor em manutenção"
                  value={
                    context.contract.serverMaintenance === null
                      ? "Não informado"
                      : context.contract.serverMaintenance
                        ? "Sim"
                        : "Não"
                  }
                />
              </dl>
            )}
          </div>

          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              Chamados abertos no ReceitaNet
            </h3>
            {ticketsError ? (
              <p className="mt-1 text-sm text-amber-700">{ticketsError}</p>
            ) : context.tickets.items.length === 0 ? (
              <p className="mt-1 text-sm text-slate-500">
                Nenhum chamado aberto para este cliente.
              </p>
            ) : (
              <>
                <ul className="mt-2 space-y-2">
                  {context.tickets.items.map((ticket) => (
                    <li
                      key={ticket.externalId}
                      className="rounded-lg border border-slate-200 px-3 py-2"
                    >
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                        <span className="font-medium text-slate-900">
                          Nº {ticket.externalNumber ?? "—"}
                        </span>
                        {ticket.protocol && (
                          <span className="text-slate-500">
                            Protocolo {ticket.protocol}
                          </span>
                        )}
                        {ticket.typeCode && (
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
                            Tipo {ticket.typeCode}
                          </span>
                        )}
                      </div>
                      {ticket.forecast && (
                        <p className="mt-1 text-xs text-slate-500">
                          Previsão: {ticket.forecast}
                        </p>
                      )}
                      {ticket.description && (
                        <p className="mt-1 whitespace-pre-line text-sm text-slate-700">
                          {ticket.description}
                        </p>
                      )}
                      {ticket.contactPhone && (
                        <p className="mt-1 text-xs text-slate-500">
                          Contato informado no chamado:{" "}
                          {formatBrazilianPhone(ticket.contactPhone)}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
                {context.tickets.cap !== null &&
                  context.tickets.items.length >= context.tickets.cap && (
                    <p className="mt-2 text-xs text-amber-700">
                      O ReceitaNet retorna no máximo {context.tickets.cap} chamados
                      abertos por cliente. Pode haver mais.
                    </p>
                  )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
