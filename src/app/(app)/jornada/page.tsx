import type { Metadata } from "next";
import { requirePageProfile } from "@/lib/guards";
import { getTeamWorkday, listCompanyAdjustments } from "@/lib/time-clock";
import { EmptyState } from "@/components/EmptyState";
import { AdjustmentDecisionButtons } from "@/components/AdjustmentDecisionButtons";

export const metadata: Metadata = {
  title: "Jornada da equipe",
};

/**
 * Quem está trabalhando agora (PRD §231).
 *
 * ## O que esta tela NÃO é
 *
 * Não é folha de pagamento. O AlfaOS registra e apresenta o que foi registrado
 * — não calcula verba, não aplica convenção e não decide desconto (§230). A
 * mesma fronteira que a §219 fixou para custódia.
 *
 * ## Por que a lista parte dos USUÁRIOS
 *
 * "Não iniciou" é o estado que o gestor precisa ver, e uma consulta que
 * partisse das jornadas mostraria só quem bateu.
 *
 * ## Papéis
 *
 * A LISTA é de ADMIN e DISPATCHER: saber quem está em jornada é insumo direto
 * do despacho, e negá-la obrigaria o despachante a perguntar por WhatsApp.
 * DECIDIR correção é só do ADMIN — é autoridade sobre o registro de outra
 * pessoa, da mesma família de administrar usuário e credencial.
 */

const STATE_LABEL: Record<string, string> = {
  NOT_STARTED: "Não iniciou",
  WORKING: "Trabalhando",
  ON_BREAK: "Em intervalo",
  FINISHED: "Encerrada",
};

/** Cor semântica, sempre acompanhada do rótulo — cor não é o único sinal. */
const STATE_CLASS: Record<string, string> = {
  NOT_STARTED: "bg-neutral-bg text-neutral-fg",
  WORKING: "bg-success-bg text-success-fg",
  ON_BREAK: "bg-warning-bg text-warning-fg",
  FINISHED: "bg-info-bg text-info-fg",
};

function minutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

function time(value: Date | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

export default async function TeamWorkdayPage() {
  const session = await requirePageProfile(["ADMIN", "DISPATCHER"]);

  const team = await getTeamWorkday(session.companyId);
  // A fila de correções só é carregada para quem pode decidi-la.
  const adjustments =
    session.profile === "ADMIN"
      ? await listCompanyAdjustments(session.companyId, "PENDING")
      : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-fg">Jornada da equipe</h1>
        <p className="mt-1 text-sm text-fg-muted">
          {team.date} · fuso {team.timezone}. O horário de cada marcação é
          registrado pelo servidor e não pode ser editado — correções passam por
          aprovação.
        </p>
      </div>

      {team.members.length === 0 ? (
        <EmptyState
          title="Nenhum funcionário ativo"
          description="A jornada aparece aqui assim que houver usuários ativos na empresa."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface-muted text-left text-fg-muted">
              <tr>
                <th className="px-4 py-3 font-medium">Funcionário</th>
                <th className="px-4 py-3 font-medium">Situação</th>
                <th className="px-4 py-3 font-medium">Última marcação</th>
                <th className="px-4 py-3 font-medium">Trabalhado</th>
                <th className="px-4 py-3 font-medium">Correções</th>
              </tr>
            </thead>
            <tbody>
              {team.members.map((member) => (
                <tr key={member.userId} className="border-t border-border">
                  <td className="px-4 py-3 text-fg">{member.userName}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${
                        STATE_CLASS[member.state] ?? STATE_CLASS.NOT_STARTED
                      }`}
                    >
                      {STATE_LABEL[member.state] ?? member.state}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-fg-muted">
                    {time(member.lastEntryAt)}
                  </td>
                  <td className="px-4 py-3 text-fg-muted">
                    {minutes(member.workedMinutes)}
                  </td>
                  <td className="px-4 py-3 text-fg-muted">
                    {member.pendingAdjustments > 0
                      ? `${member.pendingAdjustments} pendente(s)`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {session.profile === "ADMIN" && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-fg">
            Correções aguardando decisão
          </h2>
          {adjustments.length === 0 ? (
            <EmptyState
              title="Nenhuma correção pendente"
              description="Pedidos abertos pelo aplicativo do técnico aparecem aqui."
            />
          ) : (
            <ul className="space-y-3">
              {adjustments.map((adjustment) => (
                <li
                  key={adjustment.id}
                  className="rounded-lg border border-border p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-fg">
                        {adjustment.requestedByName} · {adjustment.workdayDate}
                      </p>
                      <p className="mt-1 text-sm text-fg-muted">
                        Pede {adjustment.requestedEntryType} às{" "}
                        {time(adjustment.requestedOccurredAt)}
                      </p>
                      {/*
                        O motivo é do funcionário e aparece como TEXTO.

                        Ele é a razão de o pedido existir: sem ele, a decisão
                        aconteceria sem motivo declarado e sem contraditório.
                      */}
                      <p className="mt-2 text-sm text-fg">{adjustment.reason}</p>
                    </div>
                    <AdjustmentDecisionButtons adjustmentId={adjustment.id} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
