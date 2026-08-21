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

export function UserToggleButton({ user }: { user: UserRow }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function toggle() {
    setLoading(true);
    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !user.active }),
      });
      if (res.ok) {
        router.refresh();
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={loading}
      className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        user.active
          ? "border border-red-200 text-red-600 hover:bg-red-50"
          : "border border-emerald-200 text-emerald-600 hover:bg-emerald-50"
      }`}
    >
      {loading ? "..." : user.active ? "Desativar" : "Reativar"}
    </button>
  );
}
