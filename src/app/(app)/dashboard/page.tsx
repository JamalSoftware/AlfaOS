import type { Metadata } from "next";
import { requirePageProfile } from "@/lib/guards";
import { getDashboardStats } from "@/lib/dashboard";

export const metadata: Metadata = {
  title: "Dashboard",
};

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export default async function DashboardPage() {
  const session = await requirePageProfile(["ADMIN", "DISPATCHER"]);
  const stats = await getDashboardStats(session.companyId);

  const cards = [
    {
      label: "OS Pendentes",
      value: stats.osPendentes,
      accent: "bg-amber-50 text-amber-700",
    },
    {
      label: "Em Atendimento",
      value: stats.osEmAtendimento,
      accent: "bg-blue-50 text-blue-700",
    },
    {
      label: "Concluídas Hoje",
      value: stats.osConcluidasHoje,
      accent: "bg-emerald-50 text-emerald-700",
    },
    {
      label: "Técnicos Ativos",
      value: stats.tecnicosAtivos,
      accent: "bg-violet-50 text-violet-700",
    },
  ];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
        <p className="mt-1 text-sm text-slate-500">
          Bem-vindo(a), {session.name}.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <div
            key={card.label}
            className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
          >
            <p className="text-sm font-medium text-slate-500">{card.label}</p>
            <div className="mt-3 flex items-end justify-between">
              <span className="text-3xl font-bold text-slate-900">
                {card.value}
              </span>
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${card.accent}`}
              >
                {card.label.split(" ")[0]}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-4 text-base font-semibold text-slate-900">
          Atividade recente
        </h2>
        {stats.recentActivity.length === 0 ? (
          <p className="text-sm text-slate-500">
            Nenhuma atividade registrada ainda.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {stats.recentActivity.map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-800">
                    {item.action}
                  </p>
                  {item.entity && (
                    <p className="truncate text-xs text-slate-500">
                      {item.entity}
                      {item.userName ? ` · ${item.userName}` : ""}
                    </p>
                  )}
                </div>
                <span className="ml-4 shrink-0 text-xs text-slate-400">
                  {formatDate(item.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
