"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Sincronização das OS abertas do cliente no ReceitaNet.
 *
 * Ação explícita, disparada por gente. Nada de sincronização automática nesta
 * versão: o operador precisa ver o que ela fez, e um agendamento esconderia
 * justamente o comportamento que ainda está sendo homologado.
 *
 * O resultado é CONTAGEM. Nada de JSON cru, identificador técnico do provider
 * ou detalhe de integração — quem opera precisa saber quantas OS entraram, não
 * como elas foram buscadas.
 */

interface SyncResult {
  fetched: number;
  created: number;
  updated: number;
  possiblyTruncated: boolean;
}

/** Plural sem "(s)": a frase é lida por gente. */
function contar(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function resumo(r: SyncResult): string {
  if (r.fetched === 0) {
    return "Nenhum chamado aberto no ReceitaNet para este cliente.";
  }
  const partes: string[] = [];
  if (r.created > 0) partes.push(contar(r.created, "nova", "novas"));
  if (r.updated > 0) partes.push(contar(r.updated, "atualizada", "atualizadas"));
  if (partes.length === 0) {
    return `${contar(r.fetched, "chamado", "chamados")} sem alteração.`;
  }
  return `${partes.join(" · ")} — de ${contar(r.fetched, "chamado aberto", "chamados abertos")}.`;
}

export function ReceitanetOrderSyncPanel({
  customerId,
  linked,
}: {
  customerId: string;
  /** O cliente tem vínculo com o ReceitaNet? Sem ele não há o que consultar. */
  linked: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function sync() {
    setError(null);
    // O resultado anterior sai da tela ao começar: contagem velha sob um clique
    // novo é lida como resposta nova.
    setResult(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/customers/${customerId}/receitanet-orders`, {
        method: "POST",
        // A consulta é sempre ao vivo — cache aqui mostraria a leitura de ontem.
        cache: "no-store",
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(payload?.error ?? "Não foi possível sincronizar.");
        return;
      }
      setResult(payload?.data?.sync ?? null);
      // As OS novas aparecem na listagem normal, não numa tela separada.
      router.refresh();
    } catch {
      setError("Erro de conexão. Tente novamente.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-testid="receitanet-order-sync"
      className="rounded-2xl border border-border bg-surface p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-fg">
          Ordens de serviço ReceitaNet
        </h2>
        <button
          type="button"
          data-testid="sync-receitanet-orders"
          disabled={busy || !linked}
          onClick={() => void sync()}
          className="rounded-lg border border-input-border px-3 py-1.5 text-xs font-semibold text-fg-secondary transition-colors hover:bg-surface-subtle disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "Sincronizando..." : "Sincronizar"}
        </button>
      </div>

      {!linked ? (
        <p className="mt-3 text-sm text-fg-muted">
          Este cliente não está vinculado ao ReceitaNet. Importe-o do ERP para
          poder sincronizar os chamados abertos.
        </p>
      ) : (
        <p className="mt-3 text-sm text-fg-muted">
          Traz os chamados abertos deste cliente e os transforma em ordens de
          serviço do AlfaOS. As OS importadas aparecem na listagem normal, sem
          técnico, aguardando atribuição.
        </p>
      )}

      {error && (
        <div
          role="alert"
          data-testid="sync-error"
          className="mt-3 rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
        >
          {error}
        </div>
      )}

      {result && (
        <div className="mt-3 space-y-2">
          <p data-testid="sync-summary" className="text-sm font-medium text-fg">
            {resumo(result)}
          </p>

          {/*
            O provider limita a 10 e não pagina. Com 10 na resposta não há como
            saber se são todos — e apresentar a lista como completa faria o
            despachante concluir que não há mais nada.
          */}
          {result.possiblyTruncated && (
            <p
              data-testid="sync-truncated"
              className="rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning-fg"
            >
              O ReceitaNet devolve no máximo 10 chamados por consulta e não
              informa se há mais. Podem existir outros chamados abertos que não
              vieram nesta lista.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
