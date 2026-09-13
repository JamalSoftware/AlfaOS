import Link from "next/link";
import type {
  GlobalSearchGroup,
  GlobalSearchSection,
  GlobalSearchType,
} from "@/lib/global-search";
import { GLOBAL_SEARCH_MAX_QUERY, GLOBAL_SEARCH_MIN_QUERY, GLOBAL_SEARCH_PER_TYPE } from "@/lib/global-search-rules";

/**
 * A tela da busca global (GS-1). Componente de servidor: o formulário é um `GET`
 * comum para `/busca?q=`, como o das listagens — nenhuma requisição por tecla,
 * nenhuma corrida entre respostas, e a página inteira reflete UM termo.
 *
 * Cada estado diz o que aconteceu, e erro nunca é "nenhum resultado".
 */

const GROUP_LABELS: Record<GlobalSearchType, string> = {
  CUSTOMER: "Clientes",
  SERVICE_ORDER: "Ordens de serviço",
  CTO: "CTOs",
  TECHNICIAN: "Técnicos",
};

const MORE_LABELS: Record<GlobalSearchType, string> = {
  CUSTOMER: "Ver todos em Clientes",
  SERVICE_ORDER: "Ver todas em Ordens de serviço",
  CTO: "",
  TECHNICIAN: "Ver todos em Técnicos",
};

export function globalSearchHint(includesCtos: boolean): string {
  return (
    "Clientes por nome, telefone, documento, e-mail ou endereço · OS pelo número, cliente ou tipo" +
    (includesCtos ? " · CTOs pelo nome ou código" : "") +
    " · técnicos pelo nome."
  );
}

function Group({ group }: { group: GlobalSearchGroup }) {
  const headingId = `global-search-group-${group.type}`;
  return (
    <section
      aria-labelledby={headingId}
      data-testid="global-search-group"
      data-type={group.type}
      className="rounded-2xl border border-border bg-surface p-5 shadow-sm"
    >
      <h2 id={headingId} className="text-base font-semibold text-fg">
        {GROUP_LABELS[group.type]}
      </h2>
      <ul className="mt-2 divide-y divide-border-subtle">
        {group.hits.map((hit) => (
          <li
            key={`${hit.type}:${hit.id}`}
            data-testid="global-search-hit"
            data-type={hit.type}
            data-id={hit.id}
            className="py-2"
          >
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <Link
                href={hit.href}
                className="min-w-0 break-words text-sm font-medium text-primary-text hover:text-primary-text-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                {hit.title}
              </Link>
              {hit.inactive && (
                <span className="rounded-md border border-border bg-surface-muted px-1.5 py-0.5 text-xs font-medium text-fg-secondary">
                  Inativo
                </span>
              )}
            </div>
            {hit.subtitle && (
              <p className="mt-0.5 break-words text-xs text-fg-muted">{hit.subtitle}</p>
            )}
          </li>
        ))}
      </ul>
      {group.truncated && (
        <p className="mt-2 text-xs text-fg-secondary" data-testid="global-search-more">
          Mostrando os {GLOBAL_SEARCH_PER_TYPE} primeiros.{" "}
          {group.moreHref ? (
            <Link
              href={group.moreHref}
              className="font-medium text-primary-text hover:text-primary-text-hover"
            >
              {MORE_LABELS[group.type]}
            </Link>
          ) : (
            "Refine o termo para encontrar as outras."
          )}
        </p>
      )}
    </section>
  );
}

function Body({ section }: { section: GlobalSearchSection }) {
  switch (section.state) {
    case "idle":
      return null;
    case "too-short":
      return (
        <p role="status" data-testid="global-search-too-short" className="text-sm text-fg-secondary">
          Digite pelo menos {GLOBAL_SEARCH_MIN_QUERY} letras ou números — ou o número da OS.
        </p>
      );
    case "too-long":
      return (
        <p role="status" data-testid="global-search-too-long" className="text-sm text-fg-secondary">
          O termo pode ter no máximo {GLOBAL_SEARCH_MAX_QUERY} caracteres.
        </p>
      );
    case "error":
      return (
        <p
          role="alert"
          data-testid="global-search-error"
          className="rounded-2xl border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger-fg"
        >
          Não foi possível buscar agora. Tente de novo em instantes.
        </p>
      );
    case "ok":
      if (section.groups.length === 0) {
        return (
          <p data-testid="global-search-empty" className="text-sm text-fg-secondary">
            Nenhum resultado para “{section.term}”.
          </p>
        );
      }
      return (
        <div className="space-y-4">
          {section.groups.map((group) => (
            <Group key={group.type} group={group} />
          ))}
        </div>
      );
  }
}

export function GlobalSearchView({
  section,
  includesCtos,
}: {
  section: GlobalSearchSection;
  includesCtos: boolean;
}) {
  const term = section.state === "idle" ? "" : section.term;
  return (
    <div data-testid="global-search" className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold text-fg">Busca</h1>
      <p className="mt-1 text-sm text-fg-secondary">{globalSearchHint(includesCtos)}</p>
      <form
        method="get"
        action="/busca"
        role="search"
        aria-label="Refinar a busca"
        className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm"
      >
        <label htmlFor="global-search-page" className="sr-only">
          Buscar
        </label>
        <input
          id="global-search-page"
          type="search"
          name="q"
          defaultValue={term}
          maxLength={GLOBAL_SEARCH_MAX_QUERY}
          autoFocus={section.state === "idle"}
          autoComplete="off"
          placeholder="Nome, telefone, documento, endereço, nº da OS…"
          className="min-w-0 flex-1 rounded-lg border border-input-border px-3 py-2 text-sm text-fg focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus-soft"
        />
        <button
          type="submit"
          className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-fg-secondary transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          Buscar
        </button>
      </form>
      <div className="mt-6">
        <Body section={section} />
      </div>
    </div>
  );
}
