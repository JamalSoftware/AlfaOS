"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface UserRow {
  id: string;
  name: string;
  email: string;
  profile: string;
  active: boolean;
}

interface UserToggleButtonProps {
  user: UserRow;
  /**
   * When set, the button is rendered disabled and this text explains why
   * (e.g. the row belongs to the logged-in admin, who cannot deactivate
   * themselves). Server-side the same rule is enforced by the API.
   */
  disabledReason?: string;
}

export function UserToggleButton({
  user,
  disabledReason,
}: UserToggleButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !user.active }),
      });
      if (res.ok) {
        router.refresh();
        return;
      }
      // Refusals such as "last active administrator" used to fail silently:
      // the click did nothing and the row stayed unchanged with no reason.
      const payload = await res.json().catch(() => null);
      setError(payload?.error ?? "Não foi possível alterar o status.");
    } catch {
      setError("Erro de conexão. Tente novamente.");
    } finally {
      setLoading(false);
    }
  }

  const disabled = loading || disabledReason !== undefined;

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        title={disabledReason}
        className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
          user.active
            ? "border border-red-200 text-red-600 hover:bg-red-50"
            : "border border-emerald-200 text-emerald-600 hover:bg-emerald-50"
        }`}
      >
        {loading ? "..." : user.active ? "Desativar" : "Reativar"}
      </button>
      {error && (
        <p role="alert" className="max-w-[16rem] text-right text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
