import { getWorkdayHistory } from "@/lib/time-clock";
import { fieldOk, runFieldApi } from "@/lib/field/response";
import { requireFieldPrincipal } from "@/lib/field/route";
import { FieldError } from "@/lib/field/errors";

export const dynamic = "force-dynamic";

/** Teto da janela consultável de uma vez. */
const MAX_RANGE_DAYS = 92;
const DEFAULT_RANGE_DAYS = 30;

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new FieldError("VALIDATION_ERROR", "Data inválida. Use AAAA-MM-DD.");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new FieldError("VALIDATION_ERROR", "Data inválida.");
  }
  return parsed;
}

/**
 * `GET /api/field/v1/time-clock/history?from=&to=`
 *
 * Histórico de jornada do próprio funcionário — o espelho, em recorte de dias.
 *
 * **Os totais vêm calculados do servidor** (PRD §230). O aplicativo apresenta;
 * calcular horas no cliente seria uma segunda contabilidade, e a que divergisse
 * primeiro seria a que ninguém revisou.
 *
 * A janela é limitada porque isto é tela de consulta, não exportação: um pedido
 * de dois anos varreria a tabela inteira para preencher uma lista que ninguém
 * rola. Exportação de período longo é assunto do painel, com paginação própria.
 */
export async function GET(request: Request) {
  return runFieldApi(async () => {
    const principal = await requireFieldPrincipal(request);
    const url = new URL(request.url);

    const to = parseDate(url.searchParams.get("to")) ?? new Date();
    const from =
      parseDate(url.searchParams.get("from")) ??
      new Date(to.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);

    if (from.getTime() > to.getTime()) {
      throw new FieldError(
        "VALIDATION_ERROR",
        "A data inicial não pode ser depois da final.",
      );
    }
    const days = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
    if (days > MAX_RANGE_DAYS) {
      throw new FieldError(
        "VALIDATION_ERROR",
        `Período muito longo (máximo ${MAX_RANGE_DAYS} dias).`,
      );
    }

    const workdays = await getWorkdayHistory(
      principal.user.companyId,
      principal.user.id,
      from,
      to,
    );

    return fieldOk({
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      workdays,
    });
  });
}
