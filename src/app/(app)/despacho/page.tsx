import type { Metadata } from "next";
import { AccessProfile } from "@prisma/client";
import { requirePageProfile } from "@/lib/guards";
import { listActiveTechnicianOptions } from "@/lib/technicians";
import { EmptyState } from "@/components/EmptyState";
import { DispatchPanel } from "@/components/DispatchPanel";

export const metadata: Metadata = {
  title: "Despacho",
};

/**
 * Fila operacional por técnico (PRD §325, `docs/DISPATCH-QUEUE.md`).
 *
 * ## O que esta tela responde
 *
 * "Quem está atendendo o quê, e qual é a próxima OS de cada técnico." O quadro
 * da §203 decide **quem** atende; aqui se decide **em que ordem** — e esta tela
 * é a profundidade da coluna daquele quadro, não uma superfície concorrente.
 *
 * ## A tela não é autoridade
 *
 * Ela envia intenção e **substitui o próprio estado pela resposta**. Não
 * calcula posição, não reordena o que o servidor mandou e não supõe onde a OS
 * vai parar depois de uma promoção: o backend pode acomodar dentro da banda, e
 * o que vale é a posição efetiva que ele devolve.
 *
 * ## Papéis
 *
 * ADMIN e DISPATCHER. O guard aqui é conveniência de navegação — quem decide é
 * o servidor, em cada rota, e um TECHNICIAN que digitasse a URL leva 403 da API
 * mesmo se chegasse a renderizar a tela.
 *
 * A lista de técnicos vem de `listActiveTechnicianOptions`, a MESMA fonte que a
 * atribuição usa. Uma segunda lista aqui divergiria no dia em que a regra de
 * elegibilidade mudasse num lugar só.
 */
export default async function DespachoPage() {
  const session = await requirePageProfile([
    AccessProfile.ADMIN,
    AccessProfile.DISPATCHER,
  ]);

  const technicians = await listActiveTechnicianOptions(session.companyId);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-fg">Despacho</h1>
        <p className="mt-1 text-sm text-fg-muted">
          A ordem em que cada técnico deve atender. Urgentes vêm antes das
          normais; dentro da mesma prioridade, a sequência é sua.
        </p>
      </header>

      {technicians.length === 0 ? (
        <EmptyState
          title="Nenhum técnico ativo"
          description="Cadastre e ative um técnico para montar a fila dele."
        />
      ) : (
        <DispatchPanel technicians={technicians} />
      )}
    </div>
  );
}
