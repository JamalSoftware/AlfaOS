"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface AdjustmentDecisionButtonsProps {
  adjustmentId: string;
}

/**
 * Aprovar ou rejeitar uma correção de jornada.
 *
 * ## A rejeição pede motivo; a aprovação não
 *
 * Aprovar é concordar com o que a pessoa escreveu — o motivo dela já está no
 * pedido. Rejeitar é discordar, e quem discorda precisa dizer por quê: sem
 * isso, o funcionário recebe um "não" sem contraditório, que é exatamente o
 * que o fluxo de pedido existe para evitar (PRD §229).
 *
 * ## O que a aprovação faz
 *
 * Ela **não edita** a marcação original. O servidor cria uma marcação derivada
 * apontando para este pedido; a original continua no histórico. Nada aqui
 * decide isso — a tela só chama o comando.
 */
export function AdjustmentDecisionButtons({
  adjustmentId,
}: AdjustmentDecisionButtonsProps) {
  const router = useRouter();
  const [loading, setLoading] = useState<"APPROVED" | "REJECTED" | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "APPROVED" | "REJECTED") {
    if (decision === "REJECTED" && !rejecting) {
      setRejecting(true);
      return;
    }
    if (decision === "REJECTED" && reason.trim().length === 0) {
      setError("Diga por que a correção foi recusada.");
      return;
    }

    setLoading(decision);
    setError(null);
    try {
      const res = await fetch(
        `/api/time-clock/adjustments/${adjustmentId}/decision`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decision,
            decisionReason: decision === "REJECTED" ? reason.trim() : null,
          }),
        },
      );
      if (res.ok) {
        router.refresh();
        return;
      }
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      setError(payload.error ?? "Não foi possível registrar a decisão.");
    } catch {
      setError("Falha de rede. Tente de novo.");
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => decide("APPROVED")}
          disabled={loading !== null}
          className="rounded-md border border-success-border bg-success-bg px-3 py-1.5 text-sm font-medium text-success-fg disabled:opacity-60"
        >
          {loading === "APPROVED" ? "Aprovando…" : "Aprovar"}
        </button>
        <button
          type="button"
          onClick={() => decide("REJECTED")}
          disabled={loading !== null}
          className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-fg disabled:opacity-60"
        >
          {loading === "REJECTED"
            ? "Rejeitando…"
            : rejecting
              ? "Confirmar recusa"
              : "Rejeitar"}
        </button>
      </div>

      {rejecting && (
        <input
          type="text"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Motivo da recusa"
          maxLength={500}
          className="w-64 rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg"
        />
      )}

      {error && <p className="text-xs text-danger-fg">{error}</p>}
    </div>
  );
}
