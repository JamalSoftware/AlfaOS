import Link from "next/link";
import {
  formatCompanyLongDate,
  formatCompanyTime,
} from "@/lib/company-datetime";
import {
  CUSTOMER_TIMELINE_MAX,
  type CustomerTimelineItem,
  type CustomerTimelineSection as TimelineSection,
} from "@/lib/customer-timeline";
import {
  presentTimelineItem,
  timelineOrderLabel,
} from "@/lib/customer-timeline-presentation";
import { civilDateIn } from "@/lib/workday";
import { EmptyState } from "@/components/EmptyState";

/**
 * O histórico do cliente na tela do cliente — TL-1 (PRD §381).
 *
 * Renderizado no servidor: não há "carregando" que pisque nem estado no
 * cliente. "Ver eventos anteriores" é só uma nova visita com um limite maior,
 * e a âncora `#historico` devolve a pessoa a esta seção.
 *
 * Três estados que não se confundem: ERRO diz que não foi possível carregar,
 * VAZIO diz que não há registro ainda, e a LISTA agrupa por dia no fuso da
 * empresa, do mais recente ao mais antigo.
 */
export function CustomerTimelineSection({
  section,
  loadMoreHref,
}: {
  section: TimelineSection;
  /** Presente quando há itens mais antigos e o teto ainda não foi atingido. */
  loadMoreHref: string | null;
}) {
  return (
    <section
      id="historico"
      aria-labelledby="historico-titulo"
      data-testid="customer-timeline"
      className="scroll-mt-6 rounded-2xl border border-border bg-surface p-6 shadow-sm"
    >
      <div className="mb-4">
        <h2 id="historico-titulo" className="text-base font-semibold text-fg">
          Histórico do cliente
        </h2>
        <p className="mt-1 text-sm text-fg-muted">
          O que a operação registrou para este cliente, do mais recente ao mais antigo.
        </p>
      </div>

      {section.state === "error" ? (
        <p
          role="alert"
          data-testid="customer-timeline-error"
          className="rounded-xl border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger-fg"
        >
          Não foi possível carregar o histórico agora. Recarregue a página para tentar de novo.
        </p>
      ) : section.data.items.length === 0 ? (
        <div data-testid="customer-timeline-empty">
          <EmptyState
            title="Nenhum registro ainda"
            description="As OS, visitas, fotos, equipamentos e mudanças deste cliente aparecem aqui assim que forem registrados."
          />
        </div>
      ) : (
        <>
          <TimelineDays items={section.data.items} timezone={section.data.timezone} />
          {section.data.hasMore &&
            (loadMoreHref ? (
              <Link
                href={loadMoreHref}
                scroll={false}
                data-testid="customer-timeline-more"
                className="mt-4 inline-flex min-h-[2.5rem] items-center rounded-lg border border-border px-4 text-sm font-semibold text-fg-secondary transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                Ver eventos anteriores
              </Link>
            ) : (
              <p className="mt-4 text-xs text-fg-muted" data-testid="customer-timeline-cap">
                Mostrando os {CUSTOMER_TIMELINE_MAX} registros mais recentes. Os anteriores
                continuam em cada OS.
              </p>
            ))}
        </>
      )}
    </section>
  );
}

function TimelineDays({
  items,
  timezone,
}: {
  items: CustomerTimelineItem[];
  timezone: string;
}) {
  // Os itens chegam ordenados; o dia é o CIVIL da empresa, não o do servidor.
  const dias: { chave: string; itens: CustomerTimelineItem[] }[] = [];
  for (const item of items) {
    const chave = civilDateIn(item.occurredAt, timezone);
    const ultimo = dias[dias.length - 1];
    if (ultimo && ultimo.chave === chave) ultimo.itens.push(item);
    else dias.push({ chave, itens: [item] });
  }

  return (
    <div className="space-y-5">
      {dias.map((dia) => (
        <div key={dia.chave}>
          <h3
            className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-muted"
            data-testid="timeline-day"
          >
            {formatCompanyLongDate(dia.itens[0].occurredAt, timezone)}
          </h3>
          <ol className="divide-y divide-border-subtle">
            {dia.itens.map((item) => (
              <TimelineRow key={item.id} item={item} timezone={timezone} />
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

function TimelineRow({
  item,
  timezone,
}: {
  item: CustomerTimelineItem;
  timezone: string;
}) {
  const p = presentTimelineItem(item);
  const aviso = item.kind === "IMPEDIMENT";
  const cto = item.kind === "NETWORK_CONNECTED" || item.kind === "NETWORK_DISCONNECTED" ? item.cto : null;
  return (
    <li
      className="flex gap-3 py-3"
      data-testid="timeline-item"
      data-kind={item.kind}
      data-item-id={item.id}
    >
      <time
        dateTime={item.occurredAt.toISOString()}
        className="w-11 shrink-0 pt-0.5 text-xs tabular-nums text-fg-muted"
        data-testid="timeline-time"
      >
        {formatCompanyTime(item.occurredAt, timezone)}
      </time>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
              aviso
                ? "border-warning-border bg-warning-bg text-warning-fg"
                : "border-border bg-surface-muted text-fg-secondary"
            }`}
            data-testid="timeline-category"
          >
            {p.category}
          </span>
          <span className="text-sm font-medium text-fg" data-testid="timeline-title">
            {p.title}
          </span>
        </p>
        {p.description && (
          <p
            className="mt-0.5 break-words text-sm text-fg-secondary"
            data-testid="timeline-description"
          >
            {p.description}
          </p>
        )}
        {(p.actorLabel || item.order || cto) && (
          <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-fg-muted">
            {p.actorLabel && <span data-testid="timeline-actor">{p.actorLabel}</span>}
            {item.order && (
              <Link
                href={`/ordens/${item.order.id}`}
                className="font-medium text-primary-text hover:text-primary-text-hover"
                data-testid="timeline-order-link"
              >
                {timelineOrderLabel(item.order)}
              </Link>
            )}
            {cto && (
              <Link
                href={`/ctos/${cto.id}`}
                className="font-medium text-primary-text hover:text-primary-text-hover"
                data-testid="timeline-cto-link"
              >
                Abrir CTO
              </Link>
            )}
          </p>
        )}
      </div>
    </li>
  );
}
