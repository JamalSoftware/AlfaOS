import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageProfile } from "@/lib/guards";
import { getCompanyUser } from "@/lib/users";
import { getMemberWorkdayView, listOwnAdjustments } from "@/lib/time-clock";
import { utcOffsetIn } from "@/lib/workday";
import { EmptyState } from "@/components/EmptyState";
import { MemberAdjustmentForm } from "./MemberAdjustmentForm";

export const metadata: Metadata = {
  title: "Jornada do funcionário",
};

/**
 * O espelho de um dia de um funcionário, e a porta da correção (PRD §229–§231).
 *
 * ## Por que esta tela existe
 *
 * O painel da equipe responde "quem está trabalhando agora". Ele não responde
 * "o que aconteceu no dia 12" nem dá ao gestor como corrigir o esquecimento de
 * quem estava sem aparelho. Sem esta tela a única saída seria editar a marcação
 * no banco — o exato caminho que o módulo existe para não ter.
 *
 * **Só ADMIN.** É o recorte mais detalhado da jornada de outra pessoa:
 * marcação a marcação, com horário. O DISPATCHER fica na lista de situação, que
 * é o que o despacho precisa (§233).
 *
 * ## O que a correção daqui faz
 *
 * Cria um `TimeAdjustmentRequest` PENDENTE, igual ao que o aplicativo cria. Ele
 * entra na MESMA fila do painel e é aprovado pelo MESMO caminho. Nada nesta
 * tela escreve `TimeEntry`.
 */

const STATE_LABEL: Record<string, string> = {
  NOT_STARTED: "Não iniciou",
  WORKING: "Trabalhando",
  ON_BREAK: "Em intervalo",
  FINISHED: "Encerrada",
};

const ENTRY_LABEL: Record<string, string> = {
  CLOCK_IN: "Entrada",
  BREAK_START: "Início do intervalo",
  BREAK_END: "Retorno do intervalo",
  CLOCK_OUT: "Saída",
};

const STATUS_LABEL: Record<string, string> = {
  PENDING: "Aguardando decisão",
  APPROVED: "Aprovada",
  REJECTED: "Rejeitada",
};

function minutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

export default async function MemberWorkdayPage({
  params,
  searchParams,
}: {
  params: { userId: string };
  searchParams: { date?: string };
}) {
  const session = await requirePageProfile(["ADMIN"]);

  /*
    Pertinência ANTES de qualquer leitura de jornada.

    404 e não 403: confirmar que o id existe noutra empresa é exatamente o que
    uma sonda não pode aprender.
  */
  const member = await getCompanyUser(session.companyId, params.userId);
  if (!member) {
    notFound();
  }

  const raw = searchParams.date;
  const valid = typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw);
  // Meio-dia UTC: resolve para a data pedida em qualquer fuso brasileiro sem
  // cair na véspera. Mesma convenção da rota `/api/time-clock/members/:id`.
  const instant = valid ? new Date(`${raw}T12:00:00.000Z`) : new Date();

  const workday = await getMemberWorkdayView(
    session.companyId,
    params.userId,
    Number.isNaN(instant.getTime()) ? new Date() : instant,
  );

  // Os pedidos DESTE funcionário. A função é a mesma que serve o aplicativo —
  // ela recorta por (empresa, usuário), e é o recorte que o gestor precisa.
  const adjustments = await listOwnAdjustments(
    session.companyId,
    params.userId,
    20,
  );

  const hora = (value: Date) =>
    new Intl.DateTimeFormat("pt-BR", {
      timeZone: workday.timezone,
      hour: "2-digit",
      minute: "2-digit",
    }).format(value);

  const entries = workday.entries.map((entry) => ({
    id: entry.id,
    type: entry.type,
    time: hora(entry.occurredAt),
    label: ENTRY_LABEL[entry.type] ?? entry.type,
  }));

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/jornada"
          className="text-sm font-medium text-primary-text hover:text-primary-text-hover"
        >
          ← Voltar para a jornada da equipe
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-fg">{member.name}</h1>
        <p className="mt-1 text-sm text-fg-muted">
          {workday.date} · fuso {workday.timezone}. As marcações são imutáveis —
          correção é pedido com aprovação.
        </p>
      </div>

      <form method="GET" className="flex flex-wrap items-end gap-3">
        <div>
          <label
            htmlFor="date"
            className="block text-sm font-medium text-fg"
          >
            Dia
          </label>
          <input
            id="date"
            name="date"
            type="date"
            defaultValue={workday.date}
            className="mt-1 rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg"
          />
        </div>
        <button
          type="submit"
          className="rounded-md border border-border px-4 py-2 text-sm font-medium text-fg"
        >
          Ver dia
        </button>
      </form>

      <section className="rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span
            data-testid="member-workday-state"
            className="text-sm font-medium text-fg"
          >
            {STATE_LABEL[workday.state] ?? workday.state}
          </span>
          <span className="text-sm text-fg-muted">
            Trabalhado {minutes(workday.workedMinutes)} · Intervalo{" "}
            {minutes(workday.breakMinutes)}
          </span>
        </div>

        {workday.entries.length === 0 ? (
          <p className="mt-4 text-sm text-fg-muted">
            Nenhuma marcação neste dia.
          </p>
        ) : (
          <ul className="mt-4 space-y-2">
            {workday.entries.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center justify-between border-t border-border pt-2 text-sm"
              >
                <span className="text-fg">
                  {ENTRY_LABEL[entry.type] ?? entry.type}
                  {entry.fromAdjustment && (
                    // A correção aprovada é visível, nunca silenciosa (§229).
                    <span className="ml-2 text-xs text-fg-muted">
                      correção aprovada
                    </span>
                  )}
                </span>
                <span className="font-medium text-fg">
                  {hora(entry.occurredAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-fg">Corrigir jornada</h2>
        <MemberAdjustmentForm
          userId={params.userId}
          date={workday.date}
          offset={utcOffsetIn(
            new Date(`${workday.date}T12:00:00.000Z`),
            workday.timezone,
          )}
          entries={entries}
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-fg">Correções deste dia</h2>
        {adjustments.length === 0 ? (
          <EmptyState
            title="Nenhuma correção"
            description="Pedidos abertos pelo aplicativo ou por aqui aparecem nesta lista."
          />
        ) : (
          <ul className="space-y-2" data-testid="member-adjustment-list">
            {adjustments.map((adjustment) => (
              <li
                key={adjustment.id}
                className="rounded-lg border border-border p-3 text-sm"
              >
                <p className="font-medium text-fg">
                  {ENTRY_LABEL[adjustment.requestedEntryType] ??
                    adjustment.requestedEntryType}{" "}
                  às {hora(adjustment.requestedOccurredAt)} ·{" "}
                  {adjustment.workdayDate}
                </p>
                <p className="mt-1 text-fg-muted">
                  {STATUS_LABEL[adjustment.status] ?? adjustment.status} ·
                  pedido por {adjustment.requestedByName}
                </p>
                <p className="mt-1 text-fg">{adjustment.reason}</p>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-fg-muted">
          Aprovar ou rejeitar continua sendo feito na fila da{" "}
          <Link href="/jornada" className="text-primary-text underline">
            jornada da equipe
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
