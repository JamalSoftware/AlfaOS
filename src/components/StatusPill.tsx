/**
 * Indicador de estado operacional.
 *
 * Um só componente para conectividade, status de OS, prioridade e resultado
 * de ação, porque são a mesma coisa visualmente: um estado nomeado, com um
 * tom que reforça a leitura.
 *
 * > **Cor nunca é o único sinal.**
 *
 * Cada pílula carrega o rótulo por extenso e um ponto. A regra não é
 * estética: cor sozinha some sob sol direto na calçada, exclui quem tem
 * daltonismo e desaparece em captura de tela em escala de cinza — que é como
 * um chamado costuma ser encaminhado. Quem lê "● Online" entende sem
 * depender de distinguir verde de vermelho.
 *
 * Os tons vêm dos tokens semânticos, então a pílula acompanha claro e escuro
 * sem uma linha condicional.
 */

export type StatusTone =
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "progress"
  | "neutral";

const TONE_STYLES: Record<StatusTone, string> = {
  success: "bg-success-bg text-success-fg",
  warning: "bg-warning-bg text-warning-fg",
  danger: "bg-danger-bg text-danger-fg",
  info: "bg-info-bg text-info-fg",
  progress: "bg-progress-bg text-progress-fg",
  neutral: "bg-neutral-bg text-neutral-fg",
};

interface StatusPillProps {
  tone: StatusTone;
  label: string;
  /**
   * O ponto é o reforço não-textual do tom. Sai só onde ele viraria ruído —
   * numa lista longa em que a mesma pílula se repete linha após linha.
   */
  dot?: boolean;
  className?: string;
  "data-testid"?: string;
}

export function StatusPill({
  tone,
  label,
  dot = true,
  className = "",
  "data-testid": testId,
}: StatusPillProps) {
  return (
    <span
      data-testid={testId}
      data-tone={tone}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE_STYLES[tone]} ${className}`}
    >
      {dot && (
        // `currentColor` mantém o ponto amarrado ao texto: um tom novo não
        // exige lembrar de acertar o ponto também.
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-current"
        />
      )}
      {label}
    </span>
  );
}
