"use client";

import { useCallback, useEffect, useState } from "react";
import type { ServiceOrderPriority } from "@prisma/client";
import { SERVICE_ORDER_PRIORITY_LABELS } from "@/lib/service-order-labels";
import { newIdempotencyKey } from "@/lib/idempotency-key";
import { PriorityBadge, StatusBadge } from "./OrderBadges";
import { EmptyState } from "./EmptyState";

/**
 * # Painel de despacho — a fila operacional de um técnico
 *
 * PRD §316, §320, §325 e `docs/DISPATCH-QUEUE.md`.
 *
 * ## A tela NÃO é autoridade
 *
 * Todo caminho é o mesmo: intenção → API → serviço → estado autoritativo →
 * **substituição** do estado local pela resposta. Não há reordenação otimista
 * permanente, e a tela nunca supõe onde a OS foi parar: o servidor acomoda
 * dentro da banda de prioridade, e a posição efetiva é a que voltou.
 *
 * ## `queueVersion` só vem de resposta
 *
 * Nunca `+1` local. Ele é o token de compare-and-set da FILA, e inventá-lo
 * transformaria um 409 legítimo — "outra pessoa mexeu" — em sobrescrita
 * silenciosa.
 *
 * ## Arrastar é conveniência; as setas são o caminho
 *
 * `Subir`, `Descer` e `Mover para` operam só com teclado e existem em qualquer
 * dispositivo. O arrastar usa HTML5 nativo, sem dependência nova, e não é a
 * única forma de operar — em toque ele simplesmente não entra, e nada se perde.
 */

interface TechnicianOption {
  id: string;
  name: string;
}

interface QueueItem {
  serviceOrderId: string;
  number: number;
  status: string;
  priority: ServiceOrderPriority;
  position: number | null;
  type: string;
  customerName: string;
  district: string | null;
  city: string | null;
  scheduledAt: string | null;
  version: number;
}

interface QueueView {
  technician: { id: string; name: string; active: boolean };
  queueVersion: number;
  inProgress: QueueItem[];
  queued: QueueItem[];
}

/** O que a tela sabe fazer, para bloquear a ação em curso sem travar a página. */
type Pending = { orderId: string; kind: string } | null;

const PRIORITIES: ServiceOrderPriority[] = ["LOW", "NORMAL", "HIGH", "URGENT"];

/** 1ª, 2ª, 3ª — a posição precisa ser lida sem contar linhas. */
function ordinal(position: number): string {
  return `${position}ª`;
}

function formatSchedule(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function DispatchPanel({
  technicians,
}: {
  technicians: TechnicianOption[];
}) {
  const [technicianId, setTechnicianId] = useState(technicians[0]?.id ?? "");
  const [queue, setQueue] = useState<QueueView | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const loadQueue = useCallback(async (id: string) => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/dispatch/technicians/${id}/queue`, {
        cache: "no-store",
      });
      if (!res.ok) {
        setQueue(null);
        setError("Não foi possível carregar a fila deste técnico.");
        return;
      }
      setQueue((await res.json()).data.queue as QueueView);
    } catch {
      setQueue(null);
      setError("Falha de rede ao carregar a fila.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadQueue(technicianId);
  }, [technicianId, loadQueue]);

  /**
   * Envia uma mutação e **substitui** a fila pela resposta autoritativa.
   *
   * O 409 tem tratamento próprio e obrigatório: nunca é engolido, nunca vira
   * retry automático com o estado velho. Ele avisa e **recarrega** — porque a
   * causa é sempre a mesma, outra pessoa mexeu, e insistir com a leitura antiga
   * é o que produziria a sobrescrita que o CAS existe para impedir.
   */
  async function mutate(
    url: string,
    body: unknown,
    kind: string,
    orderId: string,
  ): Promise<void> {
    if (pending) return;
    setPending({ orderId, kind });
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Uma chave por INTENÇÃO. Cada clique é uma intenção nova; um reenvio
          // do mesmo clique reaproveitaria esta chave e receberia o desfecho
          // guardado em vez de mover a OS duas vezes.
          "Idempotency-Key": newIdempotencyKey(),
        },
        body: JSON.stringify(body),
      });

      if (res.status === 409) {
        setNotice(
          "A fila foi alterada por outro usuário. Recarregamos a versão mais recente.",
        );
        setDragging(null);
        await loadQueue(technicianId);
        return;
      }

      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(payload.error ?? "Não foi possível concluir a operação.");
        return;
      }

      const data = (await res.json()).data as { queue: QueueView | null };
      // O estado passa a ser o do servidor. Sem "deveria estar na posição 1".
      if (data.queue) setQueue(data.queue);
      else await loadQueue(technicianId);
    } catch {
      setError("Falha de rede. A fila não foi alterada.");
    } finally {
      setPending(null);
      setDragging(null);
    }
  }

  function move(item: QueueItem, targetPosition: number) {
    if (!queue) return;
    void mutate(
      `/api/dispatch/technicians/${technicianId}/queue/reorder`,
      {
        serviceOrderId: item.serviceOrderId,
        targetPosition,
        expectedQueueVersion: queue.queueVersion,
      },
      "move",
      item.serviceOrderId,
    );
  }

  /**
   * Reatribuição — usa a rota `/assign` que já existe, sem duplicar nada.
   *
   * **`/assign` não exige `Idempotency-Key`** (risco conhecido, registrado no
   * plano). A proteção possível aqui é de tela: o botão sai de circulação
   * enquanto a requisição corre, e `pending` bloqueia qualquer outra ação da
   * fila. Isso cobre duplo clique, não cobre reenvio depois de timeout — e
   * mudar o contrato da rota não é escopo desta fase.
   */
  function reassign(item: QueueItem, toTechnicianId: string) {
    if (!queue || pending) return;
    void (async () => {
      setPending({ orderId: item.serviceOrderId, kind: "reassign" });
      setError(null);
      setNotice(null);
      try {
        const res = await fetch(
          `/api/service-orders/${item.serviceOrderId}/assign`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              technicianId: toTechnicianId,
              expectedVersion: item.version,
            }),
          },
        );
        if (res.status === 409) {
          setNotice(
            "A OS foi alterada por outro usuário. Recarregamos a versão mais recente.",
          );
          await loadQueue(technicianId);
          return;
        }
        if (!res.ok) {
          const payload = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setError(payload.error ?? "Não foi possível reatribuir a OS.");
          return;
        }
        // A OS saiu desta fila. A de destino é lida quando o despachante for
        // até ela — recarregar duas filas aqui esconderia qual delas mudou.
        await loadQueue(technicianId);
      } catch {
        setError("Falha de rede. A OS não foi reatribuída.");
      } finally {
        setPending(null);
      }
    })();
  }

  function setPriority(item: QueueItem, priority: ServiceOrderPriority) {
    if (!queue) return;
    void mutate(
      `/api/service-orders/${item.serviceOrderId}/priority`,
      {
        priority,
        // As DUAS versões: a da OS e a da fila. Agregados diferentes, tokens
        // diferentes — um só não protege os dois.
        expectedVersion: item.version,
        expectedQueueVersion: queue.queueVersion,
      },
      "priority",
      item.serviceOrderId,
    );
  }

  const total = queue ? queue.queued.length : 0;
  const urgentes = queue
    ? queue.queued.filter((i) => i.priority === "URGENT").length
    : 0;

  return (
    <div className="space-y-5" data-testid="dispatch-panel">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg-muted">Técnico</span>
          <select
            value={technicianId}
            onChange={(e) => setTechnicianId(e.target.value)}
            data-testid="technician-select"
            className="min-w-56 rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg"
          >
            {technicians.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={() => void loadQueue(technicianId)}
          disabled={loading}
          data-testid="refresh-queue"
          className="rounded-md border border-border px-3 py-2 text-sm font-medium text-fg disabled:opacity-60"
        >
          {loading ? "Atualizando…" : "Atualizar fila"}
        </button>
      </div>

      {queue && (
        <p className="text-sm text-fg-muted" data-testid="queue-summary">
          <strong className="text-fg">{queue.technician.name}</strong> ·{" "}
          {queue.inProgress.length} em atendimento · {total} na fila ·{" "}
          {urgentes} urgente{urgentes === 1 ? "" : "s"}
        </p>
      )}

      {notice && (
        <p
          role="status"
          data-testid="queue-conflict"
          className="rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-fg"
        >
          {notice}
        </p>
      )}
      {error && (
        <p
          role="alert"
          data-testid="queue-error"
          className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
        >
          {error}
        </p>
      )}

      {loading && !queue && <p className="text-sm text-fg-muted">Carregando…</p>}

      {queue && (
        <>
          <section aria-labelledby="em-atendimento">
            <h2
              id="em-atendimento"
              className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted"
            >
              Em atendimento
            </h2>
            {queue.inProgress.length === 0 ? (
              <p className="text-sm text-fg-muted">
                Nenhuma OS em atendimento agora.
              </p>
            ) : (
              <ul className="space-y-2" data-testid="in-progress-list">
                {/*
                  COLEÇÃO, não um item: o AlfaOS permite mais de uma
                  IN_PROGRESS por técnico, e esconder as demais apagaria
                  trabalho que existe (PRD §321).
                */}
                {queue.inProgress.map((item) => (
                  <li
                    key={item.serviceOrderId}
                    data-testid={`in-progress-${item.number}`}
                    className="rounded-lg border border-progress-border bg-progress-bg px-4 py-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-fg">
                        OS Nº {item.number}
                      </span>
                      <StatusBadge status="IN_PROGRESS" />
                      <PriorityBadge priority={item.priority} />
                    </div>
                    <p className="mt-1 text-sm text-fg-muted">
                      {item.customerName} · {item.type}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="proximas">
            <h2
              id="proximas"
              className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted"
            >
              Próximas na fila
            </h2>
            {queue.queued.length === 0 ? (
              <EmptyState title="Nenhuma OS na fila deste técnico." />
            ) : (
              <ul className="space-y-2" data-testid="queue-list">
                {queue.queued.map((item, index) => (
                  <QueueCard
                    key={item.serviceOrderId}
                    item={item}
                    isFirst={index === 0}
                    isLast={index === queue.queued.length - 1}
                    total={queue.queued.length}
                    busy={pending?.orderId === item.serviceOrderId}
                    anyPending={pending !== null}
                    dragging={dragging === item.serviceOrderId}
                    onDragStart={() => setDragging(item.serviceOrderId)}
                    onDropOn={(dropped) => {
                      if (!dropped || dropped === item.serviceOrderId) return;
                      const source = queue.queued.find(
                        (q) => q.serviceOrderId === dropped,
                      );
                      if (source) move(source, item.position ?? 1);
                    }}
                    onMove={(target) => move(item, target)}
                    onPriority={(p) => setPriority(item, p)}
                    others={technicians.filter((t) => t.id !== technicianId)}
                    onReassign={(to) => reassign(item, to)}
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

interface QueueCardProps {
  item: QueueItem;
  isFirst: boolean;
  isLast: boolean;
  total: number;
  busy: boolean;
  anyPending: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDropOn: (draggedId: string | null) => void;
  onMove: (targetPosition: number) => void;
  onPriority: (priority: ServiceOrderPriority) => void;
  /** Os OUTROS tecnicos ativos: reatribuir para o mesmo nao e operacao. */
  others: TechnicianOption[];
  onReassign: (toTechnicianId: string) => void;
}

/**
 * Um lugar na fila.
 *
 * A posição vem em destaque porque é a informação que a tela existe para dar —
 * "1ª, 2ª, 3ª" precisa ser lido sem contar linhas.
 *
 * As ações NÃO replicam a precedência do domínio. `Subir` e `Descer` só
 * calculam `position ∓ 1` a partir do que o servidor mandou; quem decide se a
 * OS pode mesmo ir para lá é o backend, que acomoda dentro da banda. Desabilitar
 * a seta no primeiro e no último item é conveniência de UI, não regra.
 */
function QueueCard({
  item,
  isFirst,
  isLast,
  total,
  busy,
  anyPending,
  dragging,
  onDragStart,
  onDropOn,
  onMove,
  onPriority,
  others,
  onReassign,
}: QueueCardProps) {
  const [showPriority, setShowPriority] = useState(false);
  const [showMove, setShowMove] = useState(false);
  const [showReassign, setShowReassign] = useState(false);
  const [reassignTo, setReassignTo] = useState("");
  const [target, setTarget] = useState(String(item.position ?? 1));
  const position = item.position ?? 0;
  const disabled = anyPending;

  const quick: ServiceOrderPriority =
    item.priority === "URGENT" ? "NORMAL" : "URGENT";
  const quickLabel =
    item.priority === "URGENT" ? "Voltar para normal" : "Marcar urgente";

  return (
    <li
      data-testid={`queue-item-${item.number}`}
      draggable={!disabled}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", item.serviceOrderId);
        onDragStart();
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDropOn(e.dataTransfer.getData("text/plain") || null);
      }}
      className={`rounded-lg border border-border bg-surface px-4 py-3 ${
        dragging ? "opacity-60" : ""
      } ${busy ? "opacity-70" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          data-testid={`position-${item.number}`}
          className="min-w-9 rounded-md bg-surface-muted px-2 py-1 text-center text-sm font-bold text-fg"
        >
          {ordinal(position)}
        </span>
        <span className="font-semibold text-fg">OS Nº {item.number}</span>
        <PriorityBadge priority={item.priority} />
      </div>

      <p className="mt-1 text-sm text-fg-muted">
        {item.customerName} · {item.type}
        {item.district ? ` · ${item.district}` : ""}
      </p>

      {item.scheduledAt && (
        /*
          Agendamento é OUTRA coisa que a posição (PRD §324). Aparece em
          segundo plano e com rótulo próprio: "1ª da fila" e "próxima agendada"
          nunca são a mesma frase.
        */
        <p className="mt-0.5 text-xs text-fg-muted">
          Agendada: {formatSchedule(item.scheduledAt)}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onMove(position - 1)}
          disabled={disabled || isFirst}
          aria-label={`Subir a OS ${item.number} na fila`}
          data-testid={`move-up-${item.number}`}
          className="rounded-md border border-border px-2 py-1 text-sm text-fg disabled:opacity-40"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={() => onMove(position + 1)}
          disabled={disabled || isLast}
          aria-label={`Descer a OS ${item.number} na fila`}
          data-testid={`move-down-${item.number}`}
          className="rounded-md border border-border px-2 py-1 text-sm text-fg disabled:opacity-40"
        >
          ↓
        </button>

        <button
          type="button"
          onClick={() => onPriority(quick)}
          disabled={disabled}
          data-testid={`quick-priority-${item.number}`}
          className="rounded-md border border-border px-3 py-1 text-sm font-medium text-fg disabled:opacity-40"
        >
          {quickLabel}
        </button>

        <button
          type="button"
          onClick={() => setShowPriority((v) => !v)}
          disabled={disabled}
          aria-expanded={showPriority}
          data-testid={`priority-menu-${item.number}`}
          className="rounded-md border border-border px-3 py-1 text-sm text-fg disabled:opacity-40"
        >
          Prioridade
        </button>

        <button
          type="button"
          onClick={() => setShowMove((v) => !v)}
          disabled={disabled}
          aria-expanded={showMove}
          data-testid={`move-to-${item.number}`}
          className="rounded-md border border-border px-3 py-1 text-sm text-fg disabled:opacity-40"
        >
          Mover para…
        </button>

        {others.length > 0 && (
          <button
            type="button"
            onClick={() => setShowReassign((v) => !v)}
            disabled={disabled}
            aria-expanded={showReassign}
            data-testid={`reassign-${item.number}`}
            className="rounded-md border border-border px-3 py-1 text-sm text-fg disabled:opacity-40"
          >
            Reatribuir
          </button>
        )}
      </div>

      {showPriority && (
        /*
          O seletor COMPLETO, e não só o atalho.

          `HIGH` e `LOW` existem no domínio e há OS reais gravadas com eles. Sem
          este menu não haveria como tirar uma OS de um `HIGH` legado (`D-02`).
        */
        <div
          className="mt-2 flex flex-wrap gap-2"
          data-testid={`priority-options-${item.number}`}
        >
          {PRIORITIES.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => {
                setShowPriority(false);
                onPriority(p);
              }}
              disabled={disabled || p === item.priority}
              className="rounded-md border border-border px-2 py-1 text-xs text-fg disabled:opacity-40"
            >
              {SERVICE_ORDER_PRIORITY_LABELS[p]}
            </button>
          ))}
        </div>
      )}

      {showMove && (
        <div className="mt-2 flex items-center gap-2">
          <label className="text-xs text-fg-muted" htmlFor={`pos-${item.number}`}>
            Mover para a posição
          </label>
          <input
            id={`pos-${item.number}`}
            type="number"
            min={1}
            max={total}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            data-testid={`move-input-${item.number}`}
            className="w-16 rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg"
          />
          <button
            type="button"
            onClick={() => {
              const n = Number.parseInt(target, 10);
              if (Number.isFinite(n) && n >= 1) {
                setShowMove(false);
                onMove(n);
              }
            }}
            disabled={disabled}
            data-testid={`move-confirm-${item.number}`}
            className="rounded-md border border-border px-3 py-1 text-sm font-medium text-fg disabled:opacity-40"
          >
            Mover
          </button>
        </div>
      )}

      {showReassign && (
        /*
          Reatribuir tira a OS deste técnico e a coloca em outro — muda de quem
          é o trabalho, não a ordem dele. Por isso pede CONFIRMAÇÃO nomeada, ao
          contrário de subir e descer, que se desfazem com outro clique.
        */
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label
            className="text-xs text-fg-muted"
            htmlFor={`reassign-${item.number}-select`}
          >
            Reatribuir para
          </label>
          <select
            id={`reassign-${item.number}-select`}
            value={reassignTo}
            onChange={(e) => setReassignTo(e.target.value)}
            data-testid={`reassign-select-${item.number}`}
            className="rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg"
          >
            <option value="">Escolha um técnico…</option>
            {others.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              const alvo = others.find((t) => t.id === reassignTo);
              if (!alvo) return;
              if (
                !window.confirm(
                  `Reatribuir a OS Nº ${item.number} para ${alvo.name}?`,
                )
              ) {
                return;
              }
              setShowReassign(false);
              onReassign(alvo.id);
            }}
            disabled={disabled || reassignTo === ""}
            data-testid={`reassign-confirm-${item.number}`}
            className="rounded-md border border-border px-3 py-1 text-sm font-medium text-fg disabled:opacity-40"
          >
            Reatribuir
          </button>
        </div>
      )}
    </li>
  );
}
