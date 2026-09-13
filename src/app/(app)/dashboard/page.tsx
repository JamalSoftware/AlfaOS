import type { Metadata } from "next";
import Link from "next/link";
import { requirePageProfile } from "@/lib/guards";
import { getOperationalDashboard } from "@/lib/dashboard";
import {
  buildDashboardCards,
  dashboardCardNumberTone,
  type DashboardCard,
} from "@/lib/dashboard-cards";
import { auditActionLabel, auditEntityLabel } from "@/lib/audit-presentation";
import { formatCompanyDateTime, formatCompanyTime } from "@/lib/company-datetime";

export const metadata: Metadata = {
  title: "Dashboard",
};

/**
 * # Dashboard operacional — DASH-1 (PRD §380)
 *
 * **Todo cartão é um link para a listagem filtrada**, e a contagem da listagem
 * é a do cartão (`src/lib/dashboard.ts` explica por construção). As regras de
 * apresentação — erro, "sem leitura", cor, destino — moram em
 * `src/lib/dashboard-cards.ts`, testadas sem navegador; esta página só desenha.
 *
 * Renderizado no servidor, a cada visita: não há polling (o PRD não pede tempo
 * real) e não há estado no cliente — então não há "0 → carregando → 15" nem
 * resposta velha sobrescrevendo nova. "Atualizar" é só uma nova visita.
 */

const COR_DO_NUMERO = {
  neutro: "text-fg",
  atencao: "text-warning-fg",
  alerta: "text-danger-fg",
} as const;

function CartaoDoPainel({ cartao }: { cartao: DashboardCard }) {
  const texto = cartao.placeholder ?? String(cartao.value ?? "—");
  return (
    <Link
      href={cartao.href}
      data-testid={`dash-card-${cartao.key}`}
      aria-label={`${cartao.label}: ${texto}. Abrir a lista.`}
      className="group flex min-h-[7.25rem] flex-col rounded-2xl border border-border bg-surface p-4 shadow-sm transition-colors hover:border-border-strong hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <span className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-fg-secondary">
          {cartao.label}
        </span>
        <span
          aria-hidden="true"
          className="text-sm text-fg-muted transition-colors group-hover:text-fg-secondary"
        >
          →
        </span>
      </span>
      <span
        data-testid={`dash-value-${cartao.key}`}
        className={`mt-2 font-bold tabular-nums ${
          cartao.placeholder
            ? "text-xl text-fg-secondary"
            : `text-3xl ${COR_DO_NUMERO[dashboardCardNumberTone(cartao)]}`
        }`}
      >
        {texto}
      </span>
      <span className="mt-1 text-xs text-fg-muted">{cartao.hint}</span>
    </Link>
  );
}


export default async function DashboardPage() {
  const session = await requirePageProfile(["ADMIN", "DISPATCHER"]);
  const painel = await getOperationalDashboard({
    companyId: session.companyId,
    profile: session.profile,
  });
  const cartoes = buildDashboardCards(painel);

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-fg">Dashboard</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Bem-vindo(a), {session.name}.
          </p>
        </div>
        <p className="text-xs text-fg-muted" data-testid="dash-generated-at">
          Situação às {formatCompanyTime(painel.generatedAt, painel.timezone)} ·{" "}
          <Link
            href="/dashboard"
            className="font-semibold text-primary-text hover:text-primary-text-hover"
          >
            Atualizar
          </Link>
        </p>
      </div>

      <section aria-labelledby="dash-os" className="mb-5">
        <h2
          id="dash-os"
          className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted"
        >
          Ordens de serviço
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {cartoes.serviceOrders.map((cartao) => (
            <CartaoDoPainel key={cartao.key} cartao={cartao} />
          ))}
        </div>
      </section>

      <section aria-labelledby="dash-equipe" className="mb-6">
        <h2
          id="dash-equipe"
          className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted"
        >
          {cartoes.teamAndNetwork.length > 1 ? "Equipe e rede" : "Equipe"}
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {cartoes.teamAndNetwork.map((cartao) => (
            <CartaoDoPainel key={cartao.key} cartao={cartao} />
          ))}
        </div>
      </section>

      <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <h2 className="mb-4 text-base font-semibold text-fg">
          Atividade recente
        </h2>
        {painel.recentActivity.state !== "ok" ? (
          <p className="text-sm text-fg-muted" data-testid="dash-activity-error">
            Não foi possível carregar a atividade recente agora.
          </p>
        ) : painel.recentActivity.data.length === 0 ? (
          <p className="text-sm text-fg-muted">
            Nenhuma atividade registrada ainda.
          </p>
        ) : (
          /*
            Frase para gente, código para a trilha (DASH-1a): a ação e o
            registro são traduzidos na tela por `audit-presentation.ts`, e o
            código gravado continua no `title` — quem investiga ainda o lê sem
            abrir o banco. Nada do `AuditLog` muda.
          */
          <ul className="divide-y divide-border-subtle" data-testid="dash-activity">
            {painel.recentActivity.data.map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between py-3"
                data-testid="dash-activity-item"
              >
                <div className="min-w-0">
                  <p
                    className="truncate text-sm font-medium text-fg"
                    title={item.action}
                    data-testid="dash-activity-action"
                  >
                    {auditActionLabel(item.action)}
                  </p>
                  {(item.entity || item.userName) && (
                    <p className="truncate text-xs text-fg-muted" data-testid="dash-activity-meta">
                      {[
                        item.entity ? auditEntityLabel(item.entity) : null,
                        item.userName,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  )}
                </div>
                <span className="ml-4 shrink-0 text-xs text-fg-muted">
                  {formatCompanyDateTime(item.createdAt, painel.timezone)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
