/**
 * Seção recolhida.
 *
 * `<details>` nativo, e não um acordeão próprio: já vem com teclado, leitor de
 * tela, estado e busca do navegador (Ctrl+F encontra texto dentro de um
 * `<details>` fechado nos navegadores atuais). Uma reimplementação erraria
 * pelo menos um desses em silêncio, e nenhum deles aparece em teste de tela.
 *
 * O uso aqui é sempre o mesmo: **permissão não é o mesmo que prioridade**. O
 * ADMIN pode ver o identificador interno da OS e o contexto do provedor; nada
 * disso precisa estar aberto enquanto ele acompanha um atendimento.
 */

interface DisclosureProps {
  title: string;
  /** Uma linha sobre o que há dentro, para não exigir abrir e conferir. */
  hint?: string;
  /** Aberto por padrão. Reservado para quando o conteúdo é o fluxo principal. */
  defaultOpen?: boolean;
  "data-testid"?: string;
  children: React.ReactNode;
}

export function Disclosure({
  title,
  hint,
  defaultOpen = false,
  "data-testid": testId,
  children,
}: DisclosureProps) {
  return (
    <details
      data-testid={testId}
      open={defaultOpen}
      className="group rounded-2xl border border-border bg-surface shadow-sm"
    >
      {/*
        `list-none` + `marker:content-none` removem o triângulo padrão, que o
        Safari e o Chrome desenham de formas diferentes. A seta abaixo é
        própria e gira com o estado.

        Alvo de toque de 44px: a seção é aberta no celular como qualquer outra.
      */}
      <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-3 px-5 py-3 marker:content-none">
        <div className="min-w-0">
          <span className="text-base font-semibold text-fg">{title}</span>
          {hint && (
            <span className="mt-0.5 block text-xs text-fg-muted">{hint}</span>
          )}
        </div>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-open:rotate-180"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </summary>
      <div className="border-t border-border-subtle px-5 py-4">{children}</div>
    </details>
  );
}

/**
 * Lista de rótulo e valor que **omite o que não tem valor**.
 *
 * Uma linha com travessão não informa nada que a ausência da linha não
 * informe, e quatro delas seguidas fazem o olho pular a região inteira. Se
 * nada sobrar, quem chama decide não renderizar a seção.
 */
export function FieldList({
  rows,
}: {
  rows: { label: string; value: React.ReactNode | null | undefined }[];
}) {
  const preenchidas = rows.filter(
    (row) => row.value !== null && row.value !== undefined && row.value !== "",
  );
  if (preenchidas.length === 0) return null;

  return (
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {preenchidas.map((row) => (
        <div key={row.label}>
          <dt className="text-xs font-medium text-fg-muted">{row.label}</dt>
          <dd className="mt-0.5 break-words text-sm text-fg">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
