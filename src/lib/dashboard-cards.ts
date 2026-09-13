import type { DashboardSection, OperationalDashboard } from "./dashboard";
import {
  DASHBOARD_SLICE_COPY,
  type DashboardSliceKey,
} from "./dashboard-slice-copy";

/**
 * # Os cartões do painel — da leitura ao que a tela mostra (DASH-1)
 *
 * Função pura, separada da página, porque as regras de APRESENTAÇÃO também
 * são contrato e precisam de teste que não dependa de navegador:
 *
 * - **erro vira "—" com o motivo, nunca `0`** — um "0 atrasadas" por consulta
 *   caída diria o contrário da verdade com a cara de um dia tranquilo;
 * - **"Sem leitura" no lugar de "0 offline"** quando nenhum cliente ativo tem
 *   leitura: não saber não é estar no ar (§370);
 * - **seção oculta não gera cartão** — nem zerado;
 * - **cada cartão tem o seu destino**, e o destino é a listagem cujo número é
 *   o do cartão (PRD §380, MASTER-PLAN §4).
 *
 * A cor é parcimoniosa: o cartão é neutro e o NÚMERO só ganha tom quando é
 * sinal de atenção e maior que zero.
 */

export type DashboardCardTone = "neutro" | "atencao" | "alerta";

export interface DashboardCard {
  key: DashboardSliceKey;
  label: string;
  href: string;
  /** O que o número conta — ou por que não há número. */
  hint: string;
  value: number | null;
  /** Texto no lugar do número — "—" (erro) ou "Sem leitura". */
  placeholder?: string;
  tone: DashboardCardTone;
}

export interface DashboardCardGroups {
  serviceOrders: DashboardCard[];
  teamAndNetwork: DashboardCard[];
}

export const DASHBOARD_ERROR_HINT = "Não foi possível contar agora.";

/*
  O rótulo vem de `DASHBOARD_SLICE_COPY` pela chave (DASH-1a): o cartão e a
  faixa da listagem que ele abre dizem o mesmo nome, porque leem a mesma linha.
*/
function card<T>(
  base: Pick<DashboardCard, "href" | "tone"> & { key: DashboardSliceKey },
  section: DashboardSection<T>,
  read: (data: T) => number,
  hint: string,
): DashboardCard {
  const label = DASHBOARD_SLICE_COPY[base.key].label;
  if (section.state === "ok") {
    return { ...base, label, value: read(section.data), hint };
  }
  return { ...base, label, value: null, placeholder: "—", hint: DASHBOARD_ERROR_HINT };
}

/** "Entre 12 clientes com leitura disponível." — e o singular, sem "entre". */
export function customersWithReadingHint(comLeitura: number): string {
  return comLeitura === 1
    ? "De 1 cliente com leitura disponível."
    : `Entre ${comLeitura} clientes com leitura disponível.`;
}

/** Cor do número: só sinal de atenção, e só acima de zero. */
export function dashboardCardNumberTone(c: DashboardCard): DashboardCardTone {
  if (c.value === null || c.value === 0) return "neutro";
  return c.tone;
}

export function buildDashboardCards(
  painel: OperationalDashboard,
): DashboardCardGroups {
  const os = painel.serviceOrders;
  const serviceOrders: DashboardCard[] = [
    card(
      { key: "abertas", href: "/ordens?recorte=abertas", tone: "neutro" },
      os,
      (d) => d.abertas,
      "Ainda não concluídas nem canceladas.",
    ),
    card(
      { key: "atrasadas", href: "/ordens?recorte=atrasadas", tone: "alerta" },
      os,
      (d) => d.atrasadas,
      "Agendamento vencido e atendimento ainda não iniciado.",
    ),
    card(
      { key: "hoje", href: "/ordens?recorte=hoje", tone: "neutro" },
      os,
      (d) => d.hoje,
      "Agendadas para hoje e ainda abertas.",
    ),
    /*
      `recorte=pendentes`, e não `status=PENDING` (DASH-1a): com o filtro comum
      da tela, a listagem não sabia que a pessoa viera do painel — sem faixa de
      recorte e sem "Voltar ao Dashboard", ao contrário dos outros sete cartões.
      O predicado é o mesmo status; muda só quem o carrega.
    */
    card(
      { key: "pendentes", href: "/ordens?recorte=pendentes", tone: "atencao" },
      os,
      (d) => d.pendentes,
      "Sem técnico atribuído.",
    ),
  ];

  const teamAndNetwork: DashboardCard[] = [
    card(
      {
        key: "tecnicos-em-atendimento",
        href: "/tecnicos?emAtendimento=true",
        tone: "neutro",
      },
      painel.team,
      (d) => d.emAtendimento,
      "Com pelo menos uma OS em atendimento.",
    ),
  ];

  const clientes = painel.customers;
  if (clientes.state !== "hidden") {
    const base = {
      key: "clientes-offline" as const,
      href: "/clientes?active=true&conectividade=OFFLINE",
      tone: "alerta" as const,
    };
    if (clientes.state === "ok" && clientes.data.comLeitura === 0) {
      teamAndNetwork.push({
        ...base,
        label: DASHBOARD_SLICE_COPY[base.key].label,
        value: null,
        placeholder: "Sem leitura",
        hint: "Nenhum cliente ativo tem leitura de conectividade ainda.",
      });
    } else {
      teamAndNetwork.push(
        card(
          base,
          clientes,
          (d) => d.offline,
          clientes.state === "ok"
            ? customersWithReadingHint(clientes.data.comLeitura)
            : DASHBOARD_ERROR_HINT,
        ),
      );
    }
  }

  if (painel.ctos.state !== "hidden") {
    teamAndNetwork.push(
      card(
        { key: "ctos-com-defeito", href: "/ctos?situacao=defeito", tone: "alerta" },
        painel.ctos,
        (d) => d.comDefeito,
        "Ativas, com porta danificada.",
      ),
      card(
        {
          key: "ctos-com-os-abertas",
          href: "/ctos?situacao=com-os-abertas",
          tone: "neutro",
        },
        painel.ctos,
        (d) => d.comOsAbertas,
        "Com ao menos um cliente vinculado com OS aberta.",
      ),
    );
  }

  return { serviceOrders, teamAndNetwork };
}
