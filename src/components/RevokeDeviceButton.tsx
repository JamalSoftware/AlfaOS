"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface RevokeDeviceButtonProps {
  deviceId: string;
  /** Nome de quem usa o aparelho, para a confirmação dizer o que vai acontecer. */
  userName: string;
  /** Já revogado: o botão some e a linha só mostra o estado. */
  revoked: boolean;
}

/**
 * Revogar é irreversível pelo próprio técnico e corta o acesso na requisição
 * seguinte — então pede confirmação, no mesmo padrão do resto do AlfaOS: um
 * segundo clique no próprio botão, sem modal.
 *
 * A confirmação nomeia a PESSOA, não o id do aparelho. "Revogar cmt8…?" não é
 * uma pergunta que alguém consiga responder; "Revogar o aparelho de Tecnico
 * Alfa?" é.
 */
export function RevokeDeviceButton({
  deviceId,
  userName,
  revoked,
}: RevokeDeviceButtonProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (revoked) {
    return <span className="text-xs text-fg-muted">Revogado</span>;
  }

  async function revoke() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/mobile-devices/${deviceId}/revoke`, {
        method: "POST",
      });
      if (res.ok) {
        router.refresh();
        return;
      }
      const payload = await res.json().catch(() => null);
      setError(payload?.error ?? "Não foi possível revogar.");
    } catch {
      setError("Erro de conexão. Tente novamente.");
    } finally {
      setLoading(false);
      setConfirming(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        data-testid={`revoke-device-${deviceId}`}
        onClick={() => void revoke()}
        disabled={loading}
        className="rounded-md border border-danger-border px-3 py-1.5 text-xs font-semibold text-danger-fg transition-colors hover:bg-danger-bg disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "..." : confirming ? "Confirmar revogação" : "Revogar"}
      </button>
      {confirming && !loading && (
        <p className="max-w-[18rem] text-right text-xs text-fg-muted">
          O aparelho de {userName} perde o acesso e para de receber
          notificações. Ele não volta sozinho ao entrar de novo.
        </p>
      )}
      {error && (
        <p role="alert" className="max-w-[18rem] text-right text-xs text-danger-fg">
          {error}
        </p>
      )}
    </div>
  );
}
