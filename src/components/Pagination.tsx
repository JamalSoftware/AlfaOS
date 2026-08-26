import Link from "next/link";

interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  buildHref: (page: number) => string;
}

export function Pagination({
  page,
  pageSize,
  total,
  buildHref,
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) {
    return null;
  }

  const pages: number[] = [];
  const start = Math.max(1, page - 2);
  const end = Math.min(totalPages, page + 2);
  for (let i = start; i <= end; i += 1) {
    pages.push(i);
  }

  const linkClass =
    "inline-flex items-center justify-center rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-fg-secondary transition-colors hover:bg-surface-muted";

  return (
    <nav
      aria-label="Paginação"
      className="mt-4 flex flex-wrap items-center justify-between gap-3"
    >
      <p className="text-sm text-fg-muted">
        Mostrando {Math.min(total, (page - 1) * pageSize + 1)}–
        {Math.min(total, page * pageSize)} de {total}
      </p>
      <div className="flex items-center gap-1.5">
        {page > 1 && (
          <Link href={buildHref(page - 1)} className={linkClass}>
            Anterior
          </Link>
        )}
        {pages.map((p) => (
          <Link
            key={p}
            href={buildHref(p)}
            aria-current={p === page ? "page" : undefined}
            className={`${linkClass} ${
              p === page
                ? "border-primary bg-primary text-primary-fg hover:bg-primary-hover"
                : ""
            }`}
          >
            {p}
          </Link>
        ))}
        {page < totalPages && (
          <Link href={buildHref(page + 1)} className={linkClass}>
            Próxima
          </Link>
        )}
      </div>
    </nav>
  );
}
