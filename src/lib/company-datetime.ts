/**
 * # Data e hora no fuso da EMPRESA — para tela (DASH-1a)
 *
 * `Intl.DateTimeFormat` sem `timeZone` formata no fuso do PROCESSO, que em
 * produção costuma ser UTC: uma OS agendada para 09:00 em São Paulo apareceria
 * como 12:00. Quem decide "hoje" e "atrasada" é o fuso da empresa
 * (`civilDayBoundsIn`, `workday.ts`); a hora que a tela mostra ao lado tem de
 * ser a do mesmo relógio, ou a listagem diria "de hoje" para uma OS exibida
 * com a data de amanhã.
 *
 * O fuso chega pronto — já resolvido por `resolveTimezone` —, e esta função
 * não lê banco: ela só formata.
 */

/** "12/09/2026, 14:30" no fuso informado. */
export function formatCompanyDateTime(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  }).format(date);
}

/** "12/09/2026" no fuso informado — data sem hora (`RC-1`, débito §12). */
export function formatCompanyDate(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: timezone,
  }).format(date);
}

/** "14:30" no fuso informado. */
export function formatCompanyTime(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  }).format(date);
}

/** "12 de setembro de 2026" no fuso informado — o cabeçalho de um dia. */
export function formatCompanyLongDate(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: timezone,
  }).format(date);
}
